/**
 * XPERT BEAUTY — nightly pre-build: every ritual and every question set is made ahead of time, so no shopper waits.
 *
 * What it keeps built, for the prompts that are PUBLISHED right now:
 *   1. the default "Ritualul complet" of every in-stock product,
 *   2. the "AI Beauty Expert" questions of every in-stock product,
 *   3. the personalised rituals of the GENERAL hair / skin products (no profile score of 0.85 or more in the product's
 *      own domain; ~670 products) — one per profile of that domain (6 hair, 4 skin). Products made for a specific
 *      need, and products outside hair / skin, have only the default ritual (the product decides the routine).
 *
 * What it builds on a given night (the Lambda tells it the current prompt versions — action=prompt_versions):
 *   - NEW       never built (new products, or the first run),
 *   - CHANGED   built with an older prompt version (someone published a prompt): base ritual prompts → every ritual,
 *               a personalisation add-on → only the personalised rituals, pdp_chips → the questions,
 *   - AGED      built more than --refresh-days ago (default 25; the cache lives 30 days).
 * Everything else is skipped without calling the Lambda, so a normal night costs only the new products.
 * After a night that rebuilt CHANGED or AGED items it clears the data CDN, so product pages get the new copies.
 *
 *   node src/scripts/prebuild-xpertbeauty-rituals.mjs --dry-run          # the plan and its cost, nothing is called
 *   node src/scripts/prebuild-xpertbeauty-rituals.mjs                    # build
 *   flags: --concurrency 6   --max-builds N   --max-minutes N   --refresh-days 25   --no-profiles   --no-chips   --no-invalidate
 *   env:   XB_LAMBDA_URL (function URL), XB_CF_DISTRIBUTION (data CDN, default E1M8L85URRPIX9)
 *
 * Cost (gemini-3.8-flash): ~1 cent per ritual, ~0.5 cent per question set.
 *   First run: ~4,800 default rituals + ~4,800 question sets + ~3,700 personalised rituals ≈ 110 $ (≈ 5 h at concurrency 6).
 *   Normal night: only new products (a few per day) → cents.  After a base-prompt publish: every ritual again (≈ 85 $).
 *
 * Crontab (EC2, Europe/Bucharest), after the evening feed sync:
 *   30 1 * * * cd /home/ec2-user/runa-admin/apps/api && flock -n /tmp/xb-prebuild.lock /home/ec2-user/miniconda3/envs/myenv/bin/node src/scripts/prebuild-xpertbeauty-rituals.mjs --concurrency 6 --max-minutes 300 >> /home/ec2-user/runa-admin/logs/cron-xpertbeauty-prebuild.log 2>&1
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url"; import { execFileSync } from "child_process";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");

const STORE = "xpertbeauty.ro";
const URL_ = (process.env.XB_LAMBDA_URL || "https://usqyrb2fov3xiuwvt3bw4ipof40fbdkr.lambda-url.us-east-1.on.aws/").replace(/\/$/, "");
const CF = process.env.XB_CF_DISTRIBUTION || "E1M8L85URRPIX9";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const DRY = flag("--dry-run"), CONC = num("--concurrency", 6), MAX_BUILDS = num("--max-builds", 0), MAX_MIN = num("--max-minutes", 0);
const REFRESH_DAYS = num("--refresh-days", 25), NO_PROFILES = flag("--no-profiles"), NO_CHIPS = flag("--no-chips"), NO_INVALIDATE = flag("--no-invalidate");
const COST = { ritual: 0.01, chips: 0.005 };
const log = (...a) => console.log(`[prebuild ${new Date().toISOString().slice(11, 19)}]`, ...a);

const getJson = async (qs, timeoutMs = 170000) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL_}/?${new URLSearchParams({ domain: STORE, ...qs })}`, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j.data || j;
  } finally { clearTimeout(t); }
};

// 1) the prompt versions and the profile rule that are live
let V;
try { V = await getJson({ action: "prompt_versions" }, 30000); }
catch (e) { console.error(`[prebuild] the Lambda did not answer action=prompt_versions (${e.message}) — is the current version deployed?`); process.exit(1); }
if (!V || !V.ritual) { console.error("[prebuild] no prompt versions returned — stopping."); process.exit(1); }
const WITH_PROFILES = !NO_PROFILES && V.profileMode === "general";
if (!NO_PROFILES && V.profileMode !== "general") log(`profile mode is "${V.profileMode}" — personalised rituals are not pre-built in this mode`);
const KEYS = [...V.profiles.hair, ...V.profiles.skin];
log(`versions: ritual ${V.ritual} · personalised ${V.ritualProfile} · questions ${V.chips} · general = no score ≥ ${V.generalBelow} · refresh after ${REFRESH_DAYS} days`);

const driver = new Neo4jService().getDriver();
const stats = { products: 0, general: 0, planned: { ritual: 0, chips: 0, profile: 0 }, why: { new: 0, changed: 0, aged: 0 }, done: { ritual: 0, chips: 0, profile: 0 }, built: 0, hits: 0, noRitual: 0, errors: 0, stopped: null };
try {
  // 2) the catalog + what was built when and with which version
  const s = driver.session();
  let rows;
  try {
    // old stamps: products that are not general can only have the default variant (the stale-ritual job reads this list)
    if (!DRY) await s.run(`MATCH (p:Product {storeId:$s}) WHERE p.ritualVariants IS NOT NULL AND size(p.ritualVariants) > 1
        AND NOT (p.domain IN ['hair','skin'] AND all(k IN CASE p.domain WHEN 'hair' THEN $hair ELSE $skin END WHERE coalesce(p['pf_' + k], 0.0) < $below))
      SET p.ritualVariants = ['default']`, { s: STORE, hair: V.profiles.hair, skin: V.profiles.skin, below: V.generalBelow });
    const r = await s.run(`MATCH (p:Product {storeId:$s}) WHERE coalesce(p.inStock,true) = true
      RETURN p.id AS id, p.domain AS domain, [k IN $keys | coalesce(p['pf_' + k], 0.0)] AS pfs,
        p.ritualVer AS rv, toString(p.ritualBuiltAt) AS rAt, p.chipsVer AS cv, toString(p.chipsBuiltAt) AS cAt,
        p.ritualProfileVer AS pv, toString(p.ritualProfileBuiltAt) AS pAt`, { s: STORE, keys: KEYS });
    rows = r.records.map((x) => Object.fromEntries(x.keys.map((k) => [k, x.get(k)])));
  } finally { await s.close(); }
  stats.products = rows.length;

  const agedBefore = Date.now() - REFRESH_DAYS * 864e5;
  const need = (ver, at, want) => (!ver || !at ? "new" : ver !== want ? "changed" : Date.parse(at) < agedBefore ? "aged" : null);
  const generalKeys = (p) => {
    const v = p.pfs.map((x) => Number(x) || 0);
    if (p.domain === "hair") return v.slice(0, V.profiles.hair.length).every((x) => x < V.generalBelow) ? V.profiles.hair : null;
    if (p.domain === "skin") return v.slice(V.profiles.hair.length).every((x) => x < V.generalBelow) ? V.profiles.skin : null;
    return null;
  };

  // 3) the plan: one task per product part; new first, then changed, then aged
  const tasks = [];
  for (const p of rows) {
    const rw = need(p.rv, p.rAt, V.ritual);
    if (rw) tasks.push({ kind: "ritual", id: p.id, why: rw });
    if (!NO_CHIPS) { const cw = need(p.cv, p.cAt, V.chips); if (cw) tasks.push({ kind: "chips", id: p.id, why: cw }); }
    const keys = WITH_PROFILES ? generalKeys(p) : null;
    if (keys) { stats.general++; const pw = need(p.pv, p.pAt, V.ritualProfile); if (pw) tasks.push({ kind: "profile", id: p.id, why: pw, keys }); }
  }
  const rank = { new: 0, changed: 1, aged: 2 }, kindRank = { ritual: 0, chips: 1, profile: 2 };
  tasks.sort((a, b) => rank[a.why] - rank[b.why] || kindRank[a.kind] - kindRank[b.kind]);
  for (const t of tasks) { stats.planned[t.kind] += t.kind === "profile" ? t.keys.length : 1; stats.why[t.why]++; }
  const firstRun = rows.every((p) => !p.rv); // nothing stamped yet: older copies may still sit on the data CDN → clear it at the end
  const estimate = (stats.planned.ritual + stats.planned.profile) * COST.ritual + stats.planned.chips * COST.chips;
  log(`${rows.length} in-stock products, ${stats.general} general · to build: ${stats.planned.ritual} default rituals, ${stats.planned.chips} question sets, ${stats.planned.profile} personalised rituals`
    + ` (${stats.why.new} new, ${stats.why.changed} prompt changed, ${stats.why.aged} aged) · at most ≈ ${estimate.toFixed(0)} $`);
  if (DRY) { log("dry run — nothing called"); process.exit(0); }
  if (!tasks.length) { log("everything is built — nothing to do"); process.exit(0); }

  // 4) build
  const t0 = Date.now(); let i = 0, calls = 0, rebuiltOld = firstRun;
  const stamp = async (id, set) => { const s2 = driver.session(); try { await s2.run(`MATCH (p:Product {id:$id, storeId:$s}) SET ${set}`, { id, s: STORE, rv: V.ritual, cv: V.chips, pv: V.ritualProfile }); } finally { await s2.close(); } };
  const call = async (qs, force) => {
    const t = Date.now();
    const d = await getJson({ ...qs, ...(force ? { skipCaching: "true" } : {}) });
    calls++; (Date.now() - t > 2500 ? stats.built++ : stats.hits++);
    return d;
  };
  const worker = async () => {
    while (i < tasks.length) {
      if (MAX_BUILDS && stats.built >= MAX_BUILDS) { stats.stopped = `--max-builds ${MAX_BUILDS}`; return; }
      if (MAX_MIN && Date.now() - t0 > MAX_MIN * 60000) { stats.stopped = `--max-minutes ${MAX_MIN}`; return; }
      const t = tasks[i++];
      const force = t.why === "aged"; // same version, older than the refresh age → recompute; otherwise a normal call builds on a miss
      try {
        if (t.kind === "ritual") {
          const d = await call({ action: "complete_ritual", productId: t.id }, force);
          if (!d.ritual) stats.noRitual++;
          await stamp(t.id, "p.ritualVer = $rv, p.ritualBuiltAt = datetime(), p.ritualWarmedAt = datetime()");
          stats.done.ritual++;
        } else if (t.kind === "chips") {
          await call({ action: "product_chips", productId: t.id }, force);
          await stamp(t.id, "p.chipsVer = $cv, p.chipsBuiltAt = datetime()");
          stats.done.chips++;
        } else {
          for (const k of t.keys) { await call({ action: "complete_ritual", productId: t.id, profile: k }, force); stats.done.profile++; }
          await stamp(t.id, "p.ritualProfileVer = $pv, p.ritualProfileBuiltAt = datetime()");
        }
        if (t.why !== "new") rebuiltOld = true;
        const n = stats.done.ritual + stats.done.chips + stats.done.profile;
        if (n % 100 < (t.kind === "profile" ? t.keys.length : 1)) log(`${n} done (${stats.built} built, ${stats.hits} already cached, ${stats.errors} errors) · ${Math.round((Date.now() - t0) / 60000)} min`);
      } catch (e) { stats.errors++; if (stats.errors <= 30) log(`✗ ${t.kind} ${t.id}: ${String(e.message || e).slice(0, 120)}`); }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  const spent = (stats.built * COST.ritual).toFixed(0);
  log(`done in ${Math.round((Date.now() - t0) / 60000)} min: ${JSON.stringify(stats.done)} · ${stats.built} built (≈ ${spent} $ at most), ${stats.hits} already cached, ${stats.noRitual} products without a ritual, ${stats.errors} errors${stats.stopped ? ` · stopped by ${stats.stopped}, the rest continues next run` : ""}`);

  // 5) product pages read through the data CDN, which keeps a copy for 30 days: clear it when existing rituals were replaced
  if (rebuiltOld && !NO_INVALIDATE && CF) {
    try {
      const out = execFileSync("aws", ["cloudfront", "create-invalidation", "--distribution-id", CF, "--paths", "/*", "--query", "Invalidation.Id", "--output", "text"], { encoding: "utf8" });
      log(`data CDN cleared (${CF}, invalidation ${out.trim()})`);
    } catch (e) { log(`⚠ could not clear the data CDN ${CF}: ${String(e.message || e).slice(0, 160)}`); }
  }
} finally { await driver.close(); }
