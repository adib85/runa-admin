#!/usr/bin/env node
/**
 * Enumerate EVERY delivery city in Quicklly's full sitemap and diff against our
 * :Location set — to find cities Quicklly serves that we never captured (the last
 * coverage gap). Walks the sitemap index → all leaves, collects distinct <loc> from
 *   /indian-grocery/<loc>/<merchant>/<subcat>
 *   /indian-grocery-store/<loc>/<merchant>
 * then reports which are missing from Neo4j.
 *
 * Usage: node enumerate-quicklly-cities.mjs
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
const ORIGIN = "https://www.quicklly.com";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let a = 0; a <= 3; a++) {
    try { const r = await fetch(url, { headers: { "User-Agent": UA } }); if (r.ok) return await r.text(); if (a < 3) await sleep(1500 * (a + 1)); }
    catch { if (a < 3) await sleep(1500 * (a + 1)); }
  }
  return "";
}
const locs = xml => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1].trim());

// walk index -> leaves
const seen = new Set(), queue = [`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap_prod.xml`], leaves = [];
while (queue.length) {
  const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
  const xml = await get(u); if (!xml) continue;
  if (/<sitemapindex/i.test(xml)) for (const c of locs(xml)) queue.push(c);
  else leaves.push(xml);
}
console.log(`Walked ${seen.size} sitemaps, ${leaves.length} leaves`);

const cities = new Set();
for (const xml of leaves) {
  for (const url of locs(xml)) {
    let parts; try { parts = new URL(url).pathname.replace(/^\/|\/$/g, "").split("/"); } catch { continue; }
    if (parts[0] === "indian-grocery" && parts.length === 4) cities.add(parts[1]);
    if (parts[0] === "indian-grocery-store" && parts.length >= 3) cities.add(parts[1]);
  }
}
console.log(`Distinct Quicklly delivery cities in sitemap: ${cities.size}`);

const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const session = driver.session();
try {
  const r = await session.run(`MATCH (l:Location) RETURN collect(l.slug) AS s`);
  const ours = new Set(r.records[0].get("s"));
  const missing = [...cities].filter(c => /^[a-z0-9-]+$/.test(c) && !ours.has(c)).sort();
  const weHaveExtra = [...ours].filter(c => c && /^[a-z0-9-]+$/.test(c) && !cities.has(c)).sort();
  console.log(`\nOur Locations: ${ours.size}`);
  console.log(`Quicklly cities MISSING from our set: ${missing.length}`);
  if (missing.length) console.log("  " + missing.slice(0, 60).join(", ") + (missing.length > 60 ? `\n  …+${missing.length - 60} more` : ""));
  console.log(`\nOur Locations NOT in current sitemap (stale or our-only): ${weHaveExtra.length}`);
  if (weHaveExtra.length) console.log("  " + weHaveExtra.slice(0, 30).join(", "));
  fs.writeFileSync("/tmp/qk_missing_cities.json", JSON.stringify(missing));
  console.log(`\nWrote missing cities -> /tmp/qk_missing_cities.json`);
} finally { await session.close(); await driver.close(); }
