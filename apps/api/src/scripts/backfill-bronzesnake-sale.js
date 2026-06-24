#!/usr/bin/env node

/**
 * Bronze Snake — set p.onSale from SALE-COLLECTION membership (and p.comingSoon
 * from the Coming Soon collection).
 *
 * WHY this exists: the style-filters backfill / nightly sync derive onSale from
 * compare_at_price (v.price_old > v.price). Bronze Snake doesn't use compare-at
 * prices — their sale is the curated `womenssale` / `menssale` collections, with
 * the price simply marked down. So compare-at yields ~0 and "what's on sale?"
 * returns nothing. This script makes COLLECTION MEMBERSHIP the sale signal.
 *
 * Both-directions refresh (re-run whenever a sale starts/ends):
 *   p.onSale     = member of a SALE collection  OR  a variant still beats compare-at
 *   p.comingSoon = member of a Coming Soon collection
 * Non-members are reset to false, so items that LEFT the sale are cleared.
 *
 * Shopify access is READ-ONLY (GraphQL collection reads). Neo4j is the only thing
 * written. Default is dry-run; use --apply to write.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-bronzesnake-sale.js
 *   node apps/api/src/scripts/backfill-bronzesnake-sale.js --apply
 *   node apps/api/src/scripts/backfill-bronzesnake-sale.js --sale womenssale,menssale --coming womens-coming-soon --apply
 *   node apps/api/src/scripts/backfill-bronzesnake-sale.js --apply --token shpat_xxx
 *
 * Revert: MATCH (p:Product {storeId:'bronze-snake-1.myshopify.com'})
 *         REMOVE p.comingSoon
 *         SET p.onSale = false   // or re-run the style-filters backfill to restore compare-at state
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const API_VERSION = "2024-10";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const SALE_COLLECTIONS = flag("--sale", "womenssale,menssale").split(",").map(s => s.trim()).filter(Boolean);
const COMING_COLLECTIONS = flag("--coming", "womens-coming-soon").split(",").map(s => s.trim()).filter(Boolean);
const tokenIdx = args.indexOf("--token");

async function fetchAccessToken() {
  if (tokenIdx !== -1 && args[tokenIdx + 1]) return args[tokenIdx + 1];
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const j = await r.json();
  const t = j?.data?.accessToken;
  if (!t) throw new Error(`No accessToken for ${SHOP} (pass --token shpat_...)`);
  return t;
}

// All product ids in a collection (handle), paginated. Returns bare numeric ids.
async function collectionProductIds(token, handle) {
  const ids = new Set();
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const q = `query($handle:String!, $c:String){
      collectionByHandle(handle:$handle){
        id title
        products(first:250, after:$c){ pageInfo{hasNextPage endCursor} nodes{ id } }
      } }`;
    const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: q, variables: { handle, c: cursor } })
    });
    const j = await r.json();
    if (j.errors) throw new Error(`GraphQL (${handle}): ` + JSON.stringify(j.errors).slice(0, 300));
    const coll = j.data.collectionByHandle;
    if (!coll) { console.log(`  ⚠ collection not found: ${handle} (skipping)`); return ids; }
    for (const n of coll.products.nodes) ids.add(n.id.replace("gid://shopify/Product/", ""));
    if (!coll.products.pageInfo.hasNextPage) break;
    cursor = coll.products.pageInfo.endCursor;
    await new Promise(res => setTimeout(res, 250));
  }
  return ids;
}

async function idsForHandles(token, handles) {
  const all = new Set();
  for (const h of handles) {
    const got = await collectionProductIds(token, h);
    console.log(`  ${h.padEnd(22)} → ${got.size} products`);
    got.forEach(id => all.add(id));
  }
  return [...all];
}

async function main() {
  const token = await fetchAccessToken();
  console.log(`Mode: ${APPLY ? "APPLY (writes Neo4j)" : "DRY RUN (use --apply to write)"}`);
  console.log(`Shop: ${SHOP}`);

  console.log(`\nSALE collections:`);
  const saleIds = await idsForHandles(token, SALE_COLLECTIONS);
  console.log(`Coming Soon collections:`);
  const comingIds = COMING_COLLECTIONS.length ? await idsForHandles(token, COMING_COLLECTIONS) : [];
  console.log(`\nResolved: ${saleIds.length} sale-collection products, ${comingIds.length} coming-soon products`);

  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
  );
  const session = driver.session();
  try {
    // How many of those ids actually exist as indexed Product nodes (the rest
    // aren't in /collections/all → never synced; nothing to flag).
    const planned = await session.run(
      `MATCH (p:Product {storeId:$sid})
       WITH collect(toString(p.id)) AS have
       RETURN size([x IN $sale WHERE x IN have]) AS saleHit,
              size([x IN $coming WHERE x IN have]) AS comingHit,
              size(have) AS total`,
      { sid: SHOP, sale: saleIds, coming: comingIds }
    );
    const rec = planned.records[0];
    console.log(`Neo4j: ${rec.get("total")} indexed products | sale members present: ${rec.get("saleHit")} | coming-soon present: ${rec.get("comingHit")}`);

    if (!APPLY) { console.log("\n(dry run — nothing written)"); return; }

    // Both-directions: onSale = collection membership OR a variant still beating
    // compare-at; comingSoon = collection membership. Non-members reset to false.
    const wrote = await session.run(
      `MATCH (p:Product {storeId:$sid})
       OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
       WITH p, $saleSet AS saleSet, $comingSet AS comingSet,
            max(CASE WHEN v.price_old IS NOT NULL AND toFloat(v.price_old) > toFloat(v.price) THEN 1 ELSE 0 END) AS cmp
       SET p.onSale = (toString(p.id) IN saleSet) OR cmp = 1,
           p.comingSoon = (toString(p.id) IN comingSet)
       RETURN sum(CASE WHEN p.onSale THEN 1 ELSE 0 END) AS onSale,
              sum(CASE WHEN p.comingSoon THEN 1 ELSE 0 END) AS coming`,
      { sid: SHOP, saleSet: saleIds, comingSet: comingIds }
    );
    const w = wrote.records[0];
    console.log(`\n✅ Wrote: onSale=true on ${w.get("onSale")} products | comingSoon=true on ${w.get("coming")} products`);
    console.log(`(onSale includes any compare-at sales as well as SALE-collection members)`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => { console.error("Sale backfill failed:", e); process.exit(1); });
