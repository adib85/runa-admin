#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * XPERT BEAUTY — enrich the indexed catalog from the store's PUBLIC GraphQL (no token)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Meta feed (our primary source) lacks: structured attributes, ALL categories a product
 * belongs to (feed gives one path), and bundle composition. Magento 2.3's storefront GraphQL
 * exposes them publicly. This script reads them and writes onto the existing Product nodes:
 *
 *   p.sizeLabel / p.sizeValue / p.sizeUnit   from `gramaj` (~100% filled)  → replenishment windows
 *   p.line                                   from `gama`                    → line/brand affinity
 *   p.tipProdus                              from `tip_produs`
 *   p.attr_<code>  (labels, array)           tip_par, tip_ten, tip_piele, tip_scalp, tip_sampon,
 *                                            destinat_pentru, pentru, beneficii, forma_textura,
 *                                            nuanta, lungime_par, varsta, zona_corporala (sparse)
 *   p.magentoCategories (names, array)       + HAS_CATEGORY edges to our store-scoped Category
 *                                            nodes for EVERY category (fixes e.g. men's shampoos
 *                                            filed under Par only)  — existing nodes only
 *   (bundle)-[:BUNDLE_CONTAINS {qty}]->(child) + p.bundleComponents  for the 113+ pachete
 *   p.enrichedAt
 *
 * Their SKU == our feed id, so our node id is `xpertbeauty-<sku>`.
 *
 * GraphQL quirks on their 2.3: `sku:{eq}` / url_key filters are unreliable (Elasticsearch
 * tokenization), so bulk mode pages the ROOT category (id 2) at 300/page (~61 requests), and
 * targeted mode uses `search:"<sku>"` per product. Prices from GraphQL are NOT used (bundle
 * prices there don't match the storefront) — price/stock stay owned by the feed sync.
 *
 * Usage (from apps/api):
 *   node src/scripts/enrich-xpertbeauty-graphql.mjs --all            # initial pass, ~61 pages, polite
 *   node src/scripts/enrich-xpertbeauty-graphql.mjs --new            # only products without enrichedAt
 *   node src/scripts/enrich-xpertbeauty-graphql.mjs --all --dry-run  # read + report, no writes
 *   PAGE_DELAY_MS=2000 node ... --all                                # slower on their server
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url";
import fetch from "node-fetch";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");

const STORE = "xpertbeauty.ro";
const GQL = "https://www.xpertbeauty.ro/graphql";
const UA = "RunaSync/1.0 (+https://askruna.ai)";
const PAGE_SIZE = 300;
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || "1500", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "0", 10); // 0 = all (testing knob)
const ATTRS = ["gramaj","cantitate","gama","tip_produs","tip_par","tip_ten","tip_piele","tip_scalp","tip_sampon",
               "destinat_pentru","pentru","beneficii","forma_textura","nuanta","lungime_par","varsta","zona_corporala"];
const args = process.argv.slice(2);
const MODE_ALL = args.includes("--all"), MODE_NEW = args.includes("--new"), DRY = args.includes("--dry-run");
if (!MODE_ALL && !MODE_NEW) { console.error("usage: --all | --new  [--dry-run]"); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function gql(query, variables = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(GQL, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ query, variables }), timeout: 60000 });
      const j = await r.json();
      if (j.errors && !j.data) throw new Error(j.errors.map(e => e.message).join("; "));
      return j.data;
    } catch (e) { if (i === tries) throw e; console.warn(`  gql retry ${i}: ${e.message}`); await sleep(2000 * i); }
  }
}

// ── option id → label maps (one call) ──────────────────────────────────────────
async function loadOptionLabels() {
  const q = `{ customAttributeMetadata(attributes:[${ATTRS.map(a => `{attribute_code:"${a}",entity_type:"catalog_product"}`).join(",")}]) { items { attribute_code attribute_type attribute_options { value label } } } }`;
  const d = await gql(q);
  const maps = {};
  for (const it of d.customAttributeMetadata.items) maps[it.attribute_code] = Object.fromEntries((it.attribute_options || []).map(o => [String(o.value), o.label]));
  return maps;
}
const labelsOf = (maps, code, raw) => {
  if (raw == null || raw === "") return [];
  const m = maps[code] || {};
  return String(raw).split(",").map(v => v.trim()).filter(Boolean).map(v => m[v] || v);
};
// Size parsing. Their `gramaj` option labels are admin-typed and inconsistent ("250 ml", "2p7kg" =
// 2.7 kg with "p" as decimal separator, sometimes wrong vs the title), so we parse the TITLE first
// (what the customer sees) and fall back to the attribute label. "1 L" → 1000 ml, "kg" → g.
function parseSize(label) {
  if (!label) return null;
  const t = String(label).replace(/(\d)p(\d)/g, "$1.$2").replace(",", ".");
  const m = t.match(/([\d.]+)\s*(ml|l|g|kg|buc|bucati)\b/i);
  if (!m) return null;
  let v = parseFloat(m[1]); let u = m[2].toLowerCase();
  if (!Number.isFinite(v) || v <= 0) return null;
  if (u === "l") { v *= 1000; u = "ml"; } if (u === "kg") { v *= 1000; u = "g"; } if (u === "bucati") u = "buc";
  return { value: v, unit: u, label: m[0] };
}
const sizeClass = (v, u) => (v == null ? null : (u === "ml" || u === "g") ? (v <= 75 ? "travel" : v >= 750 ? "salon" : "standard") : null);

const ITEM_FIELDS = `id sku name type_id ${ATTRS.join(" ")} categories { id name } ... on BundleProduct { items { option_id options { quantity product { sku } } } }`;

async function* iterAll() {
  let page = 1, total = null;
  while (true) {
    const d = await gql(`{ products(filter:{category_id:{eq:"2"}}, pageSize:${PAGE_SIZE}, currentPage:${page}) { total_count page_info { total_pages } items { ${ITEM_FIELDS} } } }`);
    const p = d.products; total = p.page_info.total_pages;
    console.log(`  page ${page}/${total} — ${p.items.length} items`);
    for (const it of p.items) if (it && it.sku) yield it;   // GraphQL can return null entries for un-typed products
    if (page >= total || (MAX_PAGES && page >= MAX_PAGES)) break;
    page++; await sleep(PAGE_DELAY_MS);
  }
}
async function* iterNew(session) {
  const res = await session.run(`MATCH (p:Product {storeId:$s}) WHERE p.enrichedAt IS NULL RETURN p.id AS id`, { s: STORE });
  const skus = res.records.map(r => r.get("id").replace(/^xpertbeauty-/, ""));
  console.log(`  ${skus.length} products without enrichedAt`);
  for (const sku of skus) {
    const d = await gql(`{ products(search:${JSON.stringify(sku)}, pageSize:3) { items { ${ITEM_FIELDS} } } }`);
    const hit = (d.products.items || []).find(i => i.sku === sku);
    if (hit) yield hit; else console.warn(`  not found via search: ${sku}`);
    await sleep(400);
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
const svc = new Neo4jService(); const driver = svc.getDriver(); const session = driver.session();
const stats = { seen: 0, matched: 0, bundles: 0, bundleLinks: 0, catEdges: 0, sized: 0 };
try {
  const maps = await loadOptionLabels();
  console.log(`option label maps loaded for ${Object.keys(maps).length} attributes`);
  const src = MODE_ALL ? iterAll() : iterNew(session);
  let batch = [];
  const flush = async () => {
    if (!batch.length || DRY) { batch = []; return; }
    const r = await session.run(`
      UNWIND $rows AS row
      MATCH (p:Product {id: row.id, storeId: $s})
      SET p += row.props, p.enrichedAt = datetime()
      WITH p, row
      // every Magento category → HAS_CATEGORY to our EXISTING store-scoped Category node (by name)
      UNWIND (CASE WHEN size(row.cats) = 0 THEN [null] ELSE row.cats END) AS cn
      OPTIONAL MATCH (c:Category {storeId: $s, name: cn})
      FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | MERGE (p)-[:HAS_CATEGORY]->(c))
      WITH DISTINCT p, row
      // bundle composition → BUNDLE_CONTAINS edges to the component products (if indexed)
      UNWIND (CASE WHEN size(row.comps) = 0 THEN [null] ELSE row.comps END) AS comp
      OPTIONAL MATCH (child:Product {storeId: $s}) WHERE comp IS NOT NULL AND child.id = 'xpertbeauty-' + comp.sku
      FOREACH (_ IN CASE WHEN child IS NULL THEN [] ELSE [1] END | MERGE (p)-[bc:BUNDLE_CONTAINS]->(child) SET bc.qty = comp.qty)
      RETURN count(DISTINCT p) AS n`, { rows: batch, s: STORE });
    stats.matched += r.records[0].get("n").toNumber();
    batch = [];
  };
  for await (const it of src) {
    stats.seen++;
    const props = {};
    if (it.id != null) props.magentoId = Number(it.id);   // numeric Magento product id (the cart add URL needs it)
    const attrSize = labelsOf(maps, "gramaj", it.gramaj)[0] || labelsOf(maps, "cantitate", it.cantitate)[0];
    const size = parseSize(it.name) || parseSize(attrSize);
    if (size) { props.sizeLabel = size.label; props.sizeValue = size.value; props.sizeUnit = size.unit; props.sizeClass = sizeClass(size.value, size.unit); stats.sized++; }
    const line = labelsOf(maps, "gama", it.gama)[0]; if (line) props.line = line;
    const tp = labelsOf(maps, "tip_produs", it.tip_produs)[0]; if (tp) props.tipProdus = tp;
    for (const a of ["tip_par","tip_ten","tip_piele","tip_scalp","tip_sampon","destinat_pentru","pentru","beneficii","forma_textura","nuanta","lungime_par","varsta","zona_corporala"]) {
      const v = labelsOf(maps, a, it[a]); if (v.length) props["attr_" + a] = v;
    }
    const cats = (it.categories || []).map(c => c.name).filter(Boolean);
    props.magentoCategories = cats;
    const comps = [];
    if (it.type_id === "bundle" && it.items) {
      for (const opt of it.items) for (const o of (opt.options || [])) if (o.product?.sku) comps.push({ sku: o.product.sku, qty: o.quantity || 1 });
      props.bundleComponents = comps.map(c => c.sku); stats.bundles++; stats.bundleLinks += comps.length;
    }
    stats.catEdges += cats.length;
    batch.push({ id: "xpertbeauty-" + it.sku, props, cats, comps });
    if (batch.length >= 200) await flush();
  }
  await flush();
  console.log(`\n${DRY ? "[dry-run] " : ""}done:`, stats);
} finally { await session.close(); await driver.close(); }
