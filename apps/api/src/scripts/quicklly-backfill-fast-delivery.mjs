#!/usr/bin/env node
// Set Product.fast_delivery / fast_delivery_fee for every Quicklly product from the cached listing
// cards (data-fastdelivery / data-fastdeliveryfee). The sync now carries these per run
// (parseProductCards → stampSeen); this fills products indexed before that, so the chat's
// add-to-cart sends their cart the same flag their own cards do (cart.js addToCart_mini).
//
//   node src/scripts/quicklly-backfill-fast-delivery.mjs          # dry run
//   node src/scripts/quicklly-backfill-fast-delivery.mjs --apply
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../..");
const CACHE_ROOT = process.env.QUICKLLY_CACHE_ROOT || path.join(REPO, ".quicklly-cache");
const APPLY = process.argv.includes("--apply");
const BATCH = 5000;

const env = { ...process.env };
for (const line of (fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  const k = t.slice(0, i).trim();
  if (env[k] === undefined) env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));

// slug → Map(pid → { fast, fee })
function flagsFromCache() {
  const dir = path.join(CACHE_ROOT, "api-responses");
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(f => /-loc-.*\.html$/.test(f))) {
    const slug = f.replace(/-loc-.*$/, "");
    const m = out.get(slug) || new Map(); out.set(slug, m);
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    for (const block of html.split(/(?=<div class="clsProd)/)) {
      const pid = block.match(/data-pid="(\d+)"/); if (!pid || m.has(pid[1])) continue;
      const fm = block.match(/data-fastdelivery="([^"]*)"/i); if (!fm) continue;
      const ff = block.match(/data-fastdeliveryfee="([^"]*)"/i);
      const fee = ff && ff[1].trim() !== "" && Number.isFinite(parseFloat(ff[1])) ? parseFloat(ff[1]) : null;
      m.set(pid[1], { fast: fm[1].trim() === "1", fee });
    }
  }
  return out;
}

const session = driver.session();
try {
  const flags = flagsFromCache();
  let cards = 0; for (const m of flags.values()) cards += m.size;
  console.log(`cache: ${flags.size} stores, ${cards} cards with a fast-delivery attribute`);
  // product id = <store id prefix> + pid; read the prefix per store from one real product
  const pre = await session.run(`MATCH (s:Store)-[:HAS_PRODUCT]->(p:Product) WHERE s.id STARTS WITH 'quicklly_' AND p.sku IS NOT NULL
    WITH s.id AS sid, head(collect(p)) AS p RETURN sid, p.id AS id, p.sku AS sku`);
  const prefixBySlug = new Map();
  for (const r of pre.records) { const sid = r.get("sid"), id = r.get("id"), sku = String(r.get("sku")); if (id.endsWith(sku)) prefixBySlug.set(sid.replace(/^quicklly_/, ""), id.slice(0, id.length - sku.length)); }
  const rows = [];
  for (const [slug, m] of flags) { const prefix = prefixBySlug.get(slug); if (!prefix) continue; for (const [pid, v] of m) rows.push({ id: prefix + pid, fast: v.fast, fee: v.fee }); }
  console.log(`graph: ${prefixBySlug.size} stores matched, ${rows.length} products to stamp (fast: ${rows.filter(r => r.fast).length})`);
  if (!APPLY) { console.log("dry run (add --apply)"); }
  else {
    let done = 0, matched = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const r = await session.run(`UNWIND $rows AS r MATCH (p:Product {id: r.id}) SET p.fast_delivery = r.fast, p.fast_delivery_fee = r.fee RETURN count(p) AS n`, { rows: rows.slice(i, i + BATCH) });
      matched += r.records[0].get("n").toNumber(); done += Math.min(BATCH, rows.length - i);
      if (done % 50000 < BATCH) console.log(`  ${done}/${rows.length} (matched ${matched})`);
    }
    console.log(`applied: ${matched} products stamped`);
  }
} finally { await session.close(); await driver.close(); }
