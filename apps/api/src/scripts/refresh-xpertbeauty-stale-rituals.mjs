/**
 * XPERT BEAUTY — daily stale-ritual refresh.
 *
 * A cached "Design your Ritual" lives 30 days (DynamoDB + CloudFront). If one of its complements goes out of stock or
 * leaves the catalog in the meantime, the shopper would see a dead product. This job finds exactly those rituals and
 * recomputes them the same day (after the feed sync has updated inStock / pruned removed products).
 *
 * How it knows: the Lambda stamps every served ritual on its hero (p.ritualItems = union of complement ids across
 * cached variants, p.ritualVariants = ["default", "pf_par_vopsit", …]). So:
 *   stale hero  =  in-stock hero whose ritualItems contain an id that is now OOS or no longer exists
 *   refresh     =  call complete_ritual with skipCaching=true for EACH cached variant (the Lambda rewrites the cache and
 *                  re-stamps), then invalidate the hero's edge URLs on CloudFront so shoppers get the new copy.
 *
 *   node src/scripts/refresh-xpertbeauty-stale-rituals.mjs [--dry-run] [--max N] [--concurrency 3]
 *   env: XB_LAMBDA_URL, XB_CF_DISTRIBUTION (default E1M8L85URRPIX9 — the edge in front of the function URL)
 *
 * Cost: ~1 cent per recomputed variant; typically a few dozen heroes a day → well under 1 $/day.
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url"; import { execFileSync } from "child_process";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");

const STORE = "xpertbeauty.ro";
const URL = (process.env.XB_LAMBDA_URL || "https://usqyrb2fov3xiuwvt3bw4ipof40fbdkr.lambda-url.us-east-1.on.aws/").replace(/\/$/, "");
const CF = process.env.XB_CF_DISTRIBUTION || "E1M8L85URRPIX9";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const DRY = flag("--dry-run"), MAX = num("--max", 0), CONC = num("--concurrency", 3);

const driver = new Neo4jService().getDriver();
const s = driver.session();
const stats = { staleHeroes: 0, variants: 0, recomputed: 0, noRitual: 0, errors: 0, invalidated: 0 };
try {
  // heroes (in stock, with a stamped ritual) that reference a complement now OOS or missing
  const r = await s.run(`
    MATCH (h:Product {storeId:$s}) WHERE h.ritualItems IS NOT NULL AND coalesce(h.inStock,true) = true
    UNWIND h.ritualItems AS cid
    OPTIONAL MATCH (c:Product {id:cid, storeId:$s})
    WITH h, cid, c WHERE c IS NULL OR coalesce(c.inStock,true) = false
    WITH h, collect(DISTINCT cid + CASE WHEN c IS NULL THEN " (removed)" ELSE " (out of stock)" END) AS dead
    RETURN h.id AS id, h.title AS title, coalesce(h.ritualVariants, ["default"]) AS variants, dead
    ORDER BY h.id ${MAX ? "LIMIT toInteger($max)" : ""}`, { s: STORE, max: MAX });
  const heroes = r.records.map((x) => ({ id: x.get("id"), title: x.get("title"), variants: x.get("variants"), dead: x.get("dead") }));
  stats.staleHeroes = heroes.length; stats.variants = heroes.reduce((t, h) => t + h.variants.length, 0);
  console.log(`[stale] ${heroes.length} heroes with a dead complement (${stats.variants} cached variants)${DRY ? " — dry run" : ""}`);
  heroes.slice(0, DRY ? 30 : 8).forEach((h) => console.log(`  ${h.id}  ${String(h.title).slice(0, 50)}  variants=${h.variants.join(",")}  dead=${h.dead.join("; ")}`));
  if (DRY || !heroes.length) process.exit(0);

  // recompute every cached variant; clear the stamp first so the union is rebuilt from the fresh rituals only
  let i = 0;
  const worker = async () => {
    while (i < heroes.length) {
      const h = heroes[i++];
      const s2 = driver.session();
      try { await s2.run(`MATCH (h:Product {id:$id, storeId:$s}) REMOVE h.ritualItems, h.ritualVariants`, { id: h.id, s: STORE }); } finally { await s2.close(); }
      for (const v of h.variants) {
        const [pf, graph] = v.split("+");
        const qs = new URLSearchParams({ action: "complete_ritual", domain: STORE, productId: h.id, skipCaching: "true" });
        if (pf.startsWith("pf_")) qs.set("profile", pf.slice(3));
        if (graph === "graph") qs.set("candidates", "graph");
        try {
          const rr = await fetch(`${URL}?${qs}`); const j = await rr.json();
          if (!rr.ok || j.error) throw new Error(j.error || `HTTP ${rr.status}`);
          if (!j.data?.ritual) stats.noRitual++;
          stats.recomputed++;
        } catch (e) { stats.errors++; console.log(`  ✗ ${h.id} [${v}]: ${String(e.message || e).slice(0, 100)}`); }
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  // edge: one wildcard path per hero covers the default + every profile variant URL the widget uses
  if (CF && heroes.length) {
    const paths = heroes.map((h) => `/?action=complete_ritual&domain=${STORE}&productId=${h.id}*`);
    for (let k = 0; k < paths.length; k += 100) { // CloudFront: max 3,000 paths per invalidation; batch conservatively
      const chunk = paths.slice(k, k + 100);
      try {
        const out = execFileSync("aws", ["cloudfront", "create-invalidation", "--distribution-id", CF, "--paths", ...chunk, "--query", "Invalidation.Id", "--output", "text"], { encoding: "utf8" });
        stats.invalidated += chunk.length; console.log(`[stale] CloudFront invalidation ${out.trim()} (${chunk.length} paths)`);
      } catch (e) { console.log(`[stale] invalidation failed: ${String(e.message || e).slice(0, 120)}`); }
    }
  }
  console.log(`[stale] done: ${JSON.stringify(stats)}`);
} finally { await s.close(); await driver.close(); }
