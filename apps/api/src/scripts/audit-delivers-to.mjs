#!/usr/bin/env node
/**
 * Audit our (:Store)-[:DELIVERS_TO]->(:Location) coverage against Quicklly's authoritative
 * per-city store list (the SEO pages /indian-grocery-delivery/near-me-in-<slug>, whose
 * store cards link to /indian-grocery-store/<slug>/<store-slug>).
 *
 * For every Location that has ≥1 store in our graph, fetch its near-me page, extract the
 * stores Quicklly lists, and diff:
 *   MISSING = Quicklly lists but we don't  (under-coverage — the real risk)
 *   EXTRA   = we have but Quicklly's page doesn't (stale, or near-me display cap on big cities)
 *
 * Read-only. Caches pages under /tmp/nearme. Usage: node audit-delivers-to.mjs [--limit N]
 */
import neo4j from "neo4j-driver";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, "utf8").split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CACHE = "/tmp/nearme"; fs.mkdirSync(CACHE, { recursive: true });
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchNearMe(slug) {
  const cp = path.join(CACHE, slug + ".html");
  try { return fs.readFileSync(cp, "utf8"); } catch {}
  for (let a = 0; a <= 3; a++) {
    try {
      const res = await fetch(`https://www.quicklly.com/indian-grocery-delivery/near-me-in-${slug}`, { headers: { "User-Agent": UA } });
      if (res.status === 404) { fs.writeFileSync(cp, ""); return ""; }
      if (!res.ok) { if (a < 3) { await sleep(1500 * (a + 1)); continue; } return ""; }
      const t = await res.text(); fs.writeFileSync(cp, t); return t;
    } catch { if (a < 3) await sleep(1500 * (a + 1)); }
  }
  return "";
}
// Quicklly store slugs delivering to <slug>, from card links /indian-grocery-store/<slug>/<store>
function theirStores(html, slug) {
  const out = new Set();
  const re = new RegExp(`indian-grocery-store/${slug}/([a-z0-9-]+)`, "g");
  let m; while ((m = re.exec(html)) !== null) out.add(m[1]);
  return out;
}

async function mapPool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); }
  }));
  return res;
}

const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const session = driver.session();
try {
  const r = await session.run(`
    MATCH (st:Store)-[:DELIVERS_TO]->(l:Location) WHERE st.id STARTS WITH 'quicklly_'
    RETURN l.slug AS slug, collect(DISTINCT replace(st.id,'quicklly_','')) AS stores`);
  let locs = r.records.map(x => ({ slug: x.get("slug"), ours: new Set(x.get("stores")) }))
    .filter(l => l.slug && /^[a-z0-9-]+$/.test(l.slug));
  if (locs.length > LIMIT) locs = locs.slice(0, LIMIT);
  console.log(`Auditing ${locs.length} locations (concurrency 6)…`);

  let done = 0;
  const results = await mapPool(locs, 6, async (loc) => {
    const html = await fetchNearMe(loc.slug);
    await sleep(120);
    const theirs = theirStores(html, loc.slug);
    if (++done % 100 === 0) console.log(`  …${done}/${locs.length}`);
    const missing = [...theirs].filter(s => !loc.ours.has(s));   // Quicklly has, we don't
    const extra = [...loc.ours].filter(s => !theirs.has(s));     // we have, Quicklly page doesn't
    return { slug: loc.slug, ours: loc.ours.size, theirs: theirs.size, missing, extra, noPage: html === "" };
  });

  const withPage = results.filter(r => !r.noPage);
  const exact = withPage.filter(r => r.missing.length === 0 && r.extra.length === 0);
  const underCov = withPage.filter(r => r.missing.length > 0).sort((a, b) => b.missing.length - a.missing.length);
  const overCov = withPage.filter(r => r.extra.length > 0).sort((a, b) => b.extra.length - a.extra.length);
  const totalMissing = underCov.reduce((s, r) => s + r.missing.length, 0);
  const totalExtra = overCov.reduce((s, r) => s + r.extra.length, 0);

  console.log("\n══════════════ AUDIT SUMMARY ══════════════");
  console.log(`Locations audited:        ${withPage.length} (${results.length - withPage.length} had no near-me page)`);
  console.log(`Exact match:              ${exact.length}`);
  console.log(`Under-coverage (we miss): ${underCov.length} locations, ${totalMissing} missing store-edges`);
  console.log(`Over-coverage (we extra): ${overCov.length} locations, ${totalExtra} extra store-edges`);
  console.log("\n── Top under-coverage (Quicklly lists stores we don't deliver) ──");
  for (const r of underCov.slice(0, 20)) console.log(`  ${r.slug.padEnd(28)} ours=${r.ours} theirs=${r.theirs}  MISSING: ${r.missing.join(", ")}`);
  console.log("\n── Top over-coverage (we have, not on Quicklly's near-me page) ──");
  for (const r of overCov.slice(0, 12)) console.log(`  ${r.slug.padEnd(28)} ours=${r.ours} theirs=${r.theirs}  EXTRA: ${r.extra.join(", ")}`);

  // which missing stores are NOT in our index at all (vs just unlinked)?
  const allMissing = [...new Set(underCov.flatMap(r => r.missing))];
  const inIdx = await session.run(`UNWIND $s AS slug MATCH (st:Store {id:'quicklly_'+slug}) RETURN collect(slug) AS have`, { s: allMissing });
  const have = new Set(inIdx.records[0]?.get("have") || []);
  const notIndexed = allMissing.filter(s => !have.has(s));
  console.log(`\nDistinct missing stores: ${allMissing.length} — of which NOT in our index at all: ${notIndexed.length}`);
  if (notIndexed.length) console.log("  not indexed: " + notIndexed.slice(0, 30).join(", "));
} finally { await session.close(); await driver.close(); }
