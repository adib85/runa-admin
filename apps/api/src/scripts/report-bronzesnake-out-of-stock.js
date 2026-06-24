#!/usr/bin/env node

/**
 * Report: out-of-stock Bronze Snake products (READ-ONLY — deletes nothing).
 *
 * Uses the Shopify Admin API's REAL inventory (`totalInventory` + per-variant
 * inventoryQuantity / inventoryPolicy) — NOT the stale Neo4j numbers — to list
 * products that are sold out. Cross-references `/collections/all/products.json`
 * so you can see which sold-out products are STILL being indexed (these are the
 * ones the date-based cleanup can't catch, e.g. "sharina-boot-black").
 *
 * Usage:
 *   node apps/api/src/scripts/report-bronzesnake-out-of-stock.js
 *   node apps/api/src/scripts/report-bronzesnake-out-of-stock.js --list   # print every OOS handle
 *
 * A variant counts as IN STOCK if inventoryQuantity > 0, OR it's set to
 * "continue selling when out of stock" (inventoryPolicy = CONTINUE — still
 * purchasable), OR its inventory is untracked (inventoryQuantity null). A
 * product is OUT OF STOCK only when NONE of its variants are in stock by that
 * definition — so we never flag a backorderable or untracked product.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";

const SHOP = process.env.SHOP_DOMAIN || "bronze-snake-1.myshopify.com";
const STOREFRONT_HOST = process.env.STOREFRONT_HOST || "bronzesnake.com";
const API_VERSION = "2025-10";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const listAll = process.argv.includes("--list");

async function fetchAccessToken(shop) {
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${shop}`);
  const data = await r.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No accessToken in DB for ${shop}`);
  return token;
}

const QUERY = gql`
  query ($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active", sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title handle status totalInventory
          variants(first: 100) { edges { node { inventoryQuantity inventoryPolicy } } }
        }
      }
    }
  }
`;

// Pull every handle visible in /collections/all/products.json (what the sync uses
// as its "in stock" gate). Lets us flag OOS products that are STILL being indexed.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchStorefrontHandles() {
  const handles = new Set();
  for (let page = 1; page <= 60; page++) {
    let prods = null;
    // retry each page up to 4x with backoff — the storefront throttles bursts
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetch(`https://${STOREFRONT_HOST}/collections/all/products.json?limit=250&page=${page}`, { timeout: 20000 });
        if (r.ok) { prods = (await r.json()).products || []; break; }
      } catch { /* retry */ }
      await sleep(1500 * attempt);
    }
    if (prods === null) { console.log(`\n  ⚠ storefront page ${page} failed after retries — collection counts may be incomplete`); break; }
    if (prods.length === 0) break;
    prods.forEach(p => p.handle && handles.add(p.handle));
    await sleep(400); // be gentle between pages
  }
  return handles;
}

function classify(node) {
  const variants = (node.variants?.edges || []).map(e => e.node);
  const inStock = variants.some(v =>
    (typeof v.inventoryQuantity === "number" && v.inventoryQuantity > 0) || // has stock
    v.inventoryPolicy === "CONTINUE" ||                                     // backorderable
    v.inventoryQuantity == null                                            // untracked
  );
  return { outOfStock: !inStock, totalInventory: node.totalInventory };
}

async function main() {
  console.log(`\n── Out-of-stock report for ${SHOP} (READ-ONLY) ──\n`);
  const token = await fetchAccessToken(SHOP);
  const client = new GraphQLClient(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });

  console.log("  Fetching /collections/all visible handles…");
  const visible = await fetchStorefrontHandles();
  console.log(`  /collections/all handles: ${visible.size}`);

  console.log("  Scanning active products via Admin API (real inventory)…");
  let after = null, hasNext = true, total = 0;
  const oos = [];
  // 2x2 breakdown: (in /collections/all?) x (in stock?)
  let inColl_inStock = 0, inColl_oos = 0, notColl_inStock = 0, notColl_oos = 0;
  while (hasNext) {
    const res = await client.request(QUERY, { first: 100, after });
    const conn = res.products;
    for (const edge of conn.edges) {
      total++;
      const inCollection = visible.has(edge.node.handle);
      const { outOfStock, totalInventory } = classify(edge.node);
      if (inCollection && !outOfStock) inColl_inStock++;
      else if (inCollection && outOfStock) inColl_oos++;
      else if (!inCollection && !outOfStock) notColl_inStock++;
      else notColl_oos++;
      if (outOfStock) {
        oos.push({ handle: edge.node.handle, title: edge.node.title, totalInventory, stillIndexed: inCollection });
      }
    }
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
    process.stdout.write(`\r    scanned ${total} active products, ${oos.length} out of stock…`);
  }
  console.log("");

  const stillIndexed = oos.filter(p => p.stillIndexed);
  const inCollTotal = inColl_inStock + inColl_oos;
  const inStockTotal = inColl_inStock + notColl_inStock;
  console.log(`\n  ┌─ WHAT EXISTS ───────────────────────────────────────────────`);
  console.log(`  │ status:active products (Admin API):     ${total}`);
  console.log(`  │ in /collections/all (browsable feed):   ${inCollTotal}`);
  console.log(`  │ active but NOT in /collections/all:     ${total - inCollTotal}`);
  console.log(`  ├─ WHAT'S BUYABLE ────────────────────────────────────────────`);
  console.log(`  │ in stock (any active):                  ${inStockTotal}`);
  console.log(`  │ out of stock (any active):              ${oos.length}`);
  console.log(`  ├─ THE 2x2 (collection × stock) ──────────────────────────────`);
  console.log(`  │ in collection  & IN STOCK:   ${inColl_inStock}   ← browsable AND buyable`);
  console.log(`  │ in collection  & out of stock: ${inColl_oos}   ← visible in feed but sold out (e.g. sharina)`);
  console.log(`  │ not in collection & in stock:  ${notColl_inStock}`);
  console.log(`  │ not in collection & out of stock: ${notColl_oos}`);
  console.log(`  └─────────────────────────────────────────────────────────────`);
  console.log(`\n  OUT OF STOCK (0 sellable stock): ${oos.length}`);
  console.log(`    …still in /collections/all (survive cleanup today): ${stillIndexed.length}`);
  console.log(`    …already dropped from collection (cleanup catches):  ${oos.length - stillIndexed.length}`);

  if (stillIndexed.length > 0) {
    console.log(`\n  Sold-out BUT still indexed — these are the ones the date-based cleanup misses:`);
    (listAll ? stillIndexed : stillIndexed.slice(0, 40)).forEach(p =>
      console.log(`    - ${p.handle}  (${p.title})  totalInventory=${p.totalInventory}`)
    );
    if (!listAll && stillIndexed.length > 40) console.log(`    …and ${stillIndexed.length - 40} more (run with --list to see all)`);
  }
  console.log("");
}

main().catch(e => { console.error("Report failed:", e.message); process.exit(1); });
