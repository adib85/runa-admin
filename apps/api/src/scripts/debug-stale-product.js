#!/usr/bin/env node

/**
 * Debug Stale Product
 * Checks why an out-of-stock product still appears in widgets (outfits/similar products).
 *
 * Usage:
 *   node apps/api/src/scripts/debug-stale-product.js <storeId> <productHandle>
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import AWS from "aws-sdk";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

AWS.config.update({ region: "us-east-1" });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

const args = process.argv.slice(2);
const STORE_ID = args[0] || "wp557k-d1.myshopify.com";
const PRODUCT_HANDLE = args[1] || "black-stainless-steel-dress-watch-2";

async function fetchAccessToken(shop) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shop}`;
  const res = await fetch(url);
  const data = await res.json();
  return data?.data?.accessToken || null;
}

// ─── 1. Check Neo4j ──────────────────────────────────────────────────

async function checkNeo4j() {
  console.log(`\n══ 1. NEO4J CHECK ══`);
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product {handle: $handle, storeId: $storeId})
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.storeId AS storeId, p.lastSeenAt AS lastSeenAt,
              p.updated_at AS updated_at,
              p.complete_the_look_updated_at AS ctlUpdated,
              p.similar_product_updated_at AS spUpdated,
              p.stock_fill_pct AS stock_fill_pct,
              p.status AS status
       LIMIT 1`,
      { handle: PRODUCT_HANDLE, storeId: STORE_ID }
    );

    if (result.records.length === 0) {
      console.log(`  Product "${PRODUCT_HANDLE}" NOT FOUND in Neo4j for store ${STORE_ID}`);
      return null;
    }

    const r = result.records[0];
    const product = {
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      lastSeenAt: r.get("lastSeenAt"),
      updated_at: r.get("updated_at"),
      ctlUpdated: r.get("ctlUpdated"),
      spUpdated: r.get("spUpdated"),
      stock_fill_pct: r.get("stock_fill_pct"),
      status: r.get("status"),
    };
    console.log(`  FOUND in Neo4j:`);
    console.log(`    ID:            ${product.id}`);
    console.log(`    Title:         ${product.title}`);
    console.log(`    Status:        ${product.status || "N/A"}`);
    console.log(`    Stock fill %:  ${product.stock_fill_pct ?? "N/A"}`);
    console.log(`    lastSeenAt:    ${product.lastSeenAt || "N/A"}`);
    console.log(`    updated_at:    ${product.updated_at || "N/A"}`);
    console.log(`    CTL updated:   ${product.ctlUpdated || "N/A"}`);
    console.log(`    SP updated:    ${product.spUpdated || "N/A"}`);
    return product;
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── 2. Check Shopify ────────────────────────────────────────────────

async function checkShopify() {
  console.log(`\n══ 2. SHOPIFY CHECK ══`);
  const accessToken = await fetchAccessToken(STORE_ID);
  if (!accessToken) {
    console.log(`  Could not fetch access token for ${STORE_ID}`);
    return null;
  }

  const url = `https://${STORE_ID}/admin/api/2023-04/products.json?handle=${PRODUCT_HANDLE}&status=any`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  if (!res.ok) {
    console.log(`  Shopify API error: ${res.status} ${res.statusText}`);
    return null;
  }

  const data = await res.json();
  if (!data.products || data.products.length === 0) {
    console.log(`  Product "${PRODUCT_HANDLE}" NOT FOUND in Shopify`);
    return null;
  }

  const product = data.products[0];
  const totalInventory = (product.variants || []).reduce(
    (sum, v) => sum + (v.inventory_quantity || 0), 0
  );
  const anyAvailable = (product.variants || []).some(
    v => v.inventory_quantity > 0
  );

  console.log(`  FOUND in Shopify:`);
  console.log(`    ID:              ${product.id}`);
  console.log(`    Title:           ${product.title}`);
  console.log(`    Status:          ${product.status}`);
  console.log(`    Published:       ${product.published_at ? "YES" : "NO"}`);
  console.log(`    Total inventory: ${totalInventory}`);
  console.log(`    Any in stock:    ${anyAvailable ? "YES" : "NO"}`);
  console.log(`    Variants:`);
  (product.variants || []).forEach(v => {
    console.log(`      - ${v.title}: qty=${v.inventory_quantity}, policy=${v.inventory_policy}`);
  });

  return { ...product, totalInventory, anyAvailable };
}

// ─── 3. Check DynamoDB cache for direct entries ──────────────────────

async function checkDirectCache() {
  console.log(`\n══ 3. DIRECT CACHE ENTRIES ══`);
  const languages = ["en", "ro"];
  const cacheKeys = languages.flatMap(lang => [
    `${STORE_ID}_${PRODUCT_HANDLE}_${lang}`,
    `${STORE_ID.toLowerCase()}_similar_products_${PRODUCT_HANDLE.toLowerCase()}_${lang}`
  ]);

  for (const key of cacheKeys) {
    try {
      const result = await docClient.get({ TableName: CACHE_TABLE, Key: { id: key } }).promise();
      if (result.Item) {
        const age = result.Item.createdAt
          ? `${((Date.now() - result.Item.createdAt) / 3600000).toFixed(1)}h ago`
          : "unknown age";
        console.log(`  FOUND: ${key} (${age})`);
      } else {
        console.log(`  not found: ${key}`);
      }
    } catch (e) {
      console.log(`  error checking: ${key} — ${e.message}`);
    }
  }
}

// ─── 4. Scan cache for OTHER products referencing this handle ────────

async function checkReferencingCache() {
  console.log(`\n══ 4. CACHE ENTRIES REFERENCING "${PRODUCT_HANDLE}" ══`);
  let found = 0;
  let scanned = 0;
  let lastKey = null;

  do {
    const params = {
      TableName: CACHE_TABLE,
      IndexName: "storeId-index",
      KeyConditionExpression: "storeId = :storeId",
      ExpressionAttributeValues: { ":storeId": STORE_ID },
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await docClient.query(params).promise();
    lastKey = result.LastEvaluatedKey;
    scanned += result.Items.length;

    for (const item of result.Items) {
      const data = item.data;
      if (!data) continue;

      let references = false;
      let location = "";

      // Check outfits (Complete The Look)
      if (data.outfits) {
        for (const outfit of data.outfits) {
          const products = outfit.products_for_outfit || [];
          const match = products.find(p => p.handle === PRODUCT_HANDLE);
          if (match) {
            references = true;
            location = `outfit "${outfit.title}" → product "${match.title || match.handle}"`;
            break;
          }
        }
      }

      // Check similar products
      if (!references && data.products) {
        const match = data.products.find(p => p.handle === PRODUCT_HANDLE);
        if (match) {
          references = true;
          location = `similar/related products → "${match.title || match.handle}"`;
        }
      }

      if (references) {
        found++;
        const age = item.createdAt
          ? `${((Date.now() - item.createdAt) / 3600000).toFixed(1)}h ago`
          : "unknown age";
        console.log(`  FOUND: ${item.id} (${age})`);
        console.log(`    → ${location}`);
      }
    }
  } while (lastKey);

  console.log(`\n  Scanned ${scanned} cache entries, found ${found} referencing "${PRODUCT_HANDLE}"`);
  return found;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  Debug Stale Product                                      ║`);
  console.log(`║  Store:   ${STORE_ID.padEnd(46)}║`);
  console.log(`║  Handle:  ${PRODUCT_HANDLE.padEnd(46)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════╝`);

  await checkNeo4j();
  await checkShopify();
  await checkDirectCache();
  const refCount = await checkReferencingCache();

  console.log(`\n══ SUMMARY ══`);
  if (refCount > 0) {
    console.log(`  ${refCount} cache entries from OTHER products still reference "${PRODUCT_HANDLE}".`);
    console.log(`  These need to be regenerated or the cache entries deleted.`);
    console.log(`  The stale cleanup (sync-cleanup-stale.js) handles this when a product`);
    console.log(`  is deleted from Neo4j, but if the product is still in Neo4j (just out`);
    console.log(`  of stock), these caches won't be cleaned.`);
  } else {
    console.log(`  No cache entries reference "${PRODUCT_HANDLE}".`);
  }
  console.log("");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
