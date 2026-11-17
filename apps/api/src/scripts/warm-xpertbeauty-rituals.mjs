/**
 * SUPERSEDED on 2026-11-11 by prebuild-xpertbeauty-rituals.mjs (knows the published prompt versions, builds the
 * personalised rituals of general products too, clears the data CDN). Kept for reference; the nightly cron uses prebuild.
 *
 * XPERT BEAUTY — ritual warm-up (nightly, after the feed sync + enrichment + profiles).
 *
 * Pre-generates the DEFAULT (v1, no profile) "Design your Ritual" + the "Ask AI" chips for in-stock products that were
 * never warmed (new products), so the first shopper on a new PDP gets an instant, edge-cached answer. Profile variants are
 * NOT pre-generated (they fill in from live traffic — 10 variants × every product would be mostly unused).
 *
 *   node src/scripts/warm-xpertbeauty-rituals.mjs                 # new in-stock products only (p.ritualWarmedAt IS NULL)
 *   node src/scripts/warm-xpertbeauty-rituals.mjs --refresh 25    # ALSO recompute rituals warmed > 25 days ago (before the
 *                                                                 #   30-day cache TTL) — ~all in-stock products once a month
 *   flags: --max N  --concurrency 4  --dry-run  --invalidate (CloudFront /* after a refresh so the edge serves the new copy)
 *   env:   XB_LAMBDA_URL (function URL), XB_CF_DISTRIBUTION (edge in front of it)
 *
 * Cost: ~1 cent per ritual + ~0.5 cent per chips call on gemini-3.8-flash. New products ≈ 100–150/month → ~2 $/month.
 * A full --refresh of ~4,800 in-stock products ≈ 50–70 $. Neither runs unless this script is called (no implicit warm-up).
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url"; import { execFileSync } from "child_process";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");

const STORE = "xpertbeauty.ro";
const URL = (process.env.XB_LAMBDA_URL || "https://usqyrb2fov3xiuwvt3bw4ipof40fbdkr.lambda-url.us-east-1.on.aws/").replace(/\/$/, "");
const CF = process.env.XB_CF_DISTRIBUTION || "";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const REFRESH_DAYS = num("--refresh", 0), MAX = num("--max", 0), CONC = num("--concurrency", 4), DRY = flag("--dry-run");

const driver = new Neo4jService().getDriver();
const s = driver.session();
const stats = { candidates: 0, warmed: 0, refreshed: 0, noRitual: 0, errors: 0, ms: 0 };
try {
  const r = await s.run(`MATCH (p:Product {storeId:$s}) WHERE coalesce(p.inStock,true) = true
      AND (p.ritualWarmedAt IS NULL OR ($days > 0 AND p.ritualWarmedAt < datetime() - duration({days:$days})))
    RETURN p.id AS id, p.title AS title, p.ritualWarmedAt IS NULL AS isNew ORDER BY isNew DESC, p.id ${MAX ? "LIMIT toInteger($max)" : ""}`,
    { s: STORE, days: REFRESH_DAYS, max: MAX });
  const list = r.records.map((x) => ({ id: x.get("id"), title: x.get("title"), isNew: x.get("isNew") }));
  stats.candidates = list.length;
  console.log(`[warm] ${list.length} products (${list.filter((x) => x.isNew).length} new, ${list.filter((x) => !x.isNew).length} to refresh)${DRY ? " — dry run" : ""}`);
  if (DRY) { list.slice(0, 20).forEach((x) => console.log(`  ${x.isNew ? "NEW " : "REF "} ${x.id}  ${x.title}`)); process.exit(0); }

  const t0 = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const p = list[i++];
      const skip = p.isNew ? "" : "&skipCaching=true";
      try {
        const rr = await fetch(`${URL}?action=complete_ritual&domain=${STORE}&productId=${encodeURIComponent(p.id)}${skip}`);
        const j = await rr.json();
        if (!rr.ok || j.error) throw new Error(j.error || `HTTP ${rr.status}`);
        if (!j.data?.ritual) stats.noRitual++;
        await fetch(`${URL}?action=product_chips&domain=${STORE}&productId=${encodeURIComponent(p.id)}${skip}`).catch(() => {});
        const s2 = driver.session();
        try { await s2.run(`MATCH (p:Product {id:$id, storeId:$s}) SET p.ritualWarmedAt = datetime()`, { id: p.id, s: STORE }); } finally { await s2.close(); }
        p.isNew ? stats.warmed++ : stats.refreshed++;
        if ((stats.warmed + stats.refreshed) % 50 === 0) console.log(`  ${stats.warmed + stats.refreshed}/${list.length}  ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (e) { stats.errors++; console.log(`  ✗ ${p.id}: ${String(e.message || e).slice(0, 100)}`); }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  stats.ms = Date.now() - t0;
  console.log(`[warm] done: ${JSON.stringify(stats)}`);
  if (flag("--invalidate") && stats.refreshed > 0 && CF) {
    const out = execFileSync("aws", ["cloudfront", "create-invalidation", "--distribution-id", CF, "--paths", "/*", "--query", "Invalidation.Id", "--output", "text"], { encoding: "utf8" });
    console.log(`[warm] CloudFront invalidation ${out.trim()} on ${CF}`);
  }
} finally { await s.close(); await driver.close(); }
