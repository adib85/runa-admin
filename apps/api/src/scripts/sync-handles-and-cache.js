#!/usr/bin/env node

/**
 * Sync Handles + Cache for RunwayHer / RunwayHim
 *
 * Fixes the situation where a Shopify SEO app changed product handles, leaving
 * Neo4j and the DynamoDB cache referencing stale handles.
 *
 * For each store:
 *   1. Fetches all current Shopify products (id + handle).
 *   2. Updates Neo4j handles to match Shopify (matched by product id).
 *   3. Scans the entire DynamoDB cache for the store and:
 *      a. REWRITES the cache CONTENT — for any product reference {id, handle}
 *         inside the data, replaces stale `handle` with the current Shopify
 *         handle for that id.
 *      b. COPIES the cache to a new key when the owner handle changed
 *         (cache keys include the handle of the product the cache belongs to).
 *
 * Old cache keys are left as harmless orphans (they won't be hit by the
 * frontend any longer, since the frontend uses the new Shopify handles).
 *
 * Usage:
 *   node apps/api/src/scripts/sync-handles-and-cache.js [--shop <shop-domain>] [--dry-run]
 *
 * Examples:
 *   node apps/api/src/scripts/sync-handles-and-cache.js
 *   node apps/api/src/scripts/sync-handles-and-cache.js --shop k8xbf0-5t.myshopify.com
 *   node apps/api/src/scripts/sync-handles-and-cache.js --dry-run
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";
import neo4j from "neo4j-driver";
import AWS from "aws-sdk";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

AWS.config.update({ region: AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const DEFAULT_STORES = ["k8xbf0-5t.myshopify.com", "wp557k-d1.myshopify.com"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const shopIdx = args.indexOf("--shop");
const shopArg = shopIdx !== -1 ? args[shopIdx + 1] : null;
const STORES = shopArg ? [shopArg] : DEFAULT_STORES;

// ─── Helpers ─────────────────────────────────────────────────────────

async function fetchAccessToken(shop) {
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${shop}`);
  const data = await r.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No access token for ${shop}`);
  return token;
}

async function fetchAllShopifyHandles(shop) {
  const token = await fetchAccessToken(shop);
  const c = new GraphQLClient(`https://${shop}/admin/api/2025-10/graphql.json`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  const QUERY = `query($cursor:String,$q:String){
    products(first:250, after:$cursor, query:$q){
      pageInfo{ hasNextPage endCursor }
      edges{ node{ id handle } }
    }
  }`;
  const map = new Map(); // numeric id → handle
  let cursor = null, hasNext = true;
  while (hasNext) {
    const data = await c.request(QUERY, { cursor, q: "status:active" });
    for (const e of data.products.edges) {
      const id = e.node.id.replace("gid://shopify/Product/", "");
      map.set(id, e.node.handle);
    }
    hasNext = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }
  return map;
}

async function fetchNeo4jHandles(shop) {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product) WHERE p.storeId = $s AND p.handle IS NOT NULL
       RETURN p.id AS id, p.handle AS h`,
      { s: shop }
    );
    const map = new Map();
    for (const rec of r.records) map.set(rec.get("id"), rec.get("h"));
    return map;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function updateNeo4jHandles(shop, changes) {
  if (changes.length === 0) return 0;
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const updates = changes.map(c => ({ id: c.id, h: c.newHandle }));
    const r = await session.run(
      `UNWIND $updates AS u
       MATCH (p:Product {id: u.id, storeId: $s})
       SET p.handle = u.h
       RETURN count(p) AS n`,
      { s: shop, updates }
    );
    return r.records[0].get("n").toNumber();
  } finally {
    await session.close();
    await driver.close();
  }
}

// Recursively rewrite any object with a numeric `id` and a `handle` field,
// replacing handle with the current Shopify handle for that id.
function rewriteHandlesInObject(obj, idToHandle) {
  let touched = false;
  if (Array.isArray(obj)) {
    for (const el of obj) {
      if (rewriteHandlesInObject(el, idToHandle)) touched = true;
    }
  } else if (obj && typeof obj === "object") {
    if (obj.id != null && (obj.handle != null || obj.product_handle != null)) {
      const current = idToHandle.get(String(obj.id));
      if (current) {
        if (obj.handle && obj.handle !== current) { obj.handle = current; touched = true; }
        if (obj.product_handle && obj.product_handle !== current) { obj.product_handle = current; touched = true; }
      }
    }
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "object" && obj[k] !== null) {
        if (rewriteHandlesInObject(obj[k], idToHandle)) touched = true;
      }
    }
  }
  return touched;
}

// Parse the OWNER handle from a cache key. Returns null if not parseable.
function parseOwnerHandleFromKey(key, shop) {
  const shopLower = shop.toLowerCase();
  let prefix = null;
  if (key.startsWith(shop + "_")) prefix = shop;
  else if (key.startsWith(shopLower + "_")) prefix = shopLower;
  if (!prefix) return null;

  let rest = key.slice(prefix.length + 1);
  // strip language suffix
  const lu = rest.lastIndexOf("_");
  if (lu > 0 && /^[a-z]{2}$/i.test(rest.slice(lu + 1))) rest = rest.slice(0, lu);

  // strip known prefixes
  for (const p of ["similar_products_", "userOptions_"]) {
    if (rest.startsWith(p)) {
      rest = rest.slice(p.length);
      break;
    }
  }
  return rest || null;
}

function buildNewKey(oldKey, oldHandle, newHandle) {
  // Replace last occurrence of oldHandle in the key with newHandle (case-insensitive)
  const idx = oldKey.toLowerCase().lastIndexOf(oldHandle.toLowerCase());
  if (idx === -1) return null;
  return oldKey.slice(0, idx) + newHandle + oldKey.slice(idx + oldHandle.length);
}

async function processStore(shop) {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("STORE: " + shop + (dryRun ? "  (DRY RUN)" : ""));
  console.log("═══════════════════════════════════════════════════");

  // 1. Fetch Shopify
  console.log("[1] Fetching all Shopify products (id + handle)...");
  const shopifyMap = await fetchAllShopifyHandles(shop);
  console.log("    " + shopifyMap.size + " active Shopify products");

  // 2. Fetch Neo4j current handles
  console.log("[2] Reading Neo4j handles...");
  const neo4jMap = await fetchNeo4jHandles(shop);
  console.log("    " + neo4jMap.size + " Neo4j products");

  // 3. Compute handle changes
  const handleChanges = [];
  for (const [id, newH] of shopifyMap) {
    const oldH = neo4jMap.get(id);
    if (oldH && oldH !== newH) handleChanges.push({ id, oldHandle: oldH, newHandle: newH });
  }
  console.log("[3] Handle changes detected: " + handleChanges.length);

  // 4. Update Neo4j handles
  if (handleChanges.length > 0 && !dryRun) {
    const updated = await updateNeo4jHandles(shop, handleChanges);
    console.log("    ✓ Updated " + updated + " Neo4j handles");
  }

  // 5. Build helper maps
  // oldHandleLower → newHandle  (for cache key copy)
  const oldToNewHandle = new Map();
  for (const c of handleChanges) oldToNewHandle.set(c.oldHandle.toLowerCase(), c.newHandle);
  // id (string) → currentHandle  (for content rewrite — uses Shopify as source of truth)
  const idToHandle = new Map();
  for (const [id, h] of shopifyMap) idToHandle.set(String(id), h);

  // 6. Scan all cache for this store, rewrite content + copy to new keys
  console.log("[4] Scanning cache & rewriting content / copying keys...");
  let scanned = 0, contentRewritten = 0, keysCopied = 0, keysAlreadyExisted = 0, errors = 0;
  let lastEvalKey;
  const startTime = Date.now();
  const BATCH_CONCURRENCY = 25;

  do {
    const res = await ddb.query({
      TableName: "CacheTable",
      IndexName: "storeId-index",
      KeyConditionExpression: "storeId = :s",
      ExpressionAttributeValues: { ":s": shop },
      ExclusiveStartKey: lastEvalKey,
    }).promise();

    const items = res.Items || [];
    // Process in chunks for parallelism
    for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
      const chunk = items.slice(i, i + BATCH_CONCURRENCY);
      await Promise.all(chunk.map(async (item) => {
        try {
          scanned++;
          let needPut = false;

          // 6a. Rewrite content — replace handle inside any product reference
          if (item.data) {
            const touched = rewriteHandlesInObject(item.data, idToHandle);
            if (touched) {
              contentRewritten++;
              needPut = true;
            }
          }

          if (needPut && !dryRun) {
            await ddb.put({ TableName: "CacheTable", Item: item }).promise();
          }

          // 6b. If owner handle changed → copy to new key
          if (oldToNewHandle.size > 0) {
            const ownerHandle = parseOwnerHandleFromKey(item.id, shop);
            if (ownerHandle) {
              const newOwner = oldToNewHandle.get(ownerHandle.toLowerCase());
              if (newOwner && newOwner.toLowerCase() !== ownerHandle.toLowerCase()) {
                const newKey = buildNewKey(item.id, ownerHandle, newOwner);
                if (newKey && newKey !== item.id) {
                  if (dryRun) { keysCopied++; }
                  else {
                    try {
                      await ddb.put({
                        TableName: "CacheTable",
                        Item: { ...item, id: newKey },
                        ConditionExpression: "attribute_not_exists(id)",
                      }).promise();
                      keysCopied++;
                    } catch (e) {
                      if (e.code === "ConditionalCheckFailedException") keysAlreadyExisted++;
                      else { errors++; }
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          errors++;
        }
      }));
    }

    lastEvalKey = res.LastEvaluatedKey;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`    scanned ${scanned}, content rewritten ${contentRewritten}, keys copied ${keysCopied} (${elapsed}s)\r`);
  } while (lastEvalKey);

  console.log(`\n    ─────────────────────────────────────────`);
  console.log(`    Total cache scanned:        ${scanned}`);
  console.log(`    Cache content rewritten:    ${contentRewritten}`);
  console.log(`    Cache keys copied (new):    ${keysCopied}`);
  console.log(`    Cache keys already at new:  ${keysAlreadyExisted}`);
  if (errors > 0) console.log(`    Errors:                     ${errors}`);
  console.log(`    Elapsed:                    ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
}

async function main() {
  for (const shop of STORES) {
    try {
      await processStore(shop);
    } catch (e) {
      console.error(`\n✗ Error for ${shop}: ${e.message}`);
    }
  }
  console.log("\n✓ DONE");
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
