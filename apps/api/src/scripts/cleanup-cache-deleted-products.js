#!/usr/bin/env node

/**
 * Cleanup Cache — Remove References to Deleted/Unpublished Products
 *
 * Scans the DynamoDB cache for both runwayher and runwayhim and removes from
 * each cache item any product references whose Shopify product ID is no longer
 * in the store's ACTIVE catalog (deleted, archived, or unpublished).
 *
 * This fixes broken thumbnails / 404 links in Similar Products and Complete
 * The Look widgets, where the cache still pointed to products that have since
 * been removed from Shopify.
 *
 * Walks recursively through `data` looking for objects shaped like a product
 * (numeric `id` + `handle`/`product_handle`). If the id is not in the active
 * Shopify set, the object is removed from its parent array.
 *
 * Usage:
 *   node apps/api/src/scripts/cleanup-cache-deleted-products.js [--dry-run] [--shop <domain>]
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";
import AWS from "aws-sdk";
import { AWS_REGION } from "../sync/services/config.js";

AWS.config.update({ region: AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const DEFAULT_STORES = ["k8xbf0-5t.myshopify.com", "wp557k-d1.myshopify.com"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const shopIdx = args.indexOf("--shop");
const shopArg = shopIdx !== -1 ? args[shopIdx + 1] : null;
const STORES = shopArg ? [shopArg] : DEFAULT_STORES;

async function fetchAccessToken(shop) {
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${shop}`);
  return (await r.json())?.data?.accessToken;
}

async function fetchActiveShopifyIds(shop) {
  const token = await fetchAccessToken(shop);
  const c = new GraphQLClient(`https://${shop}/admin/api/2025-10/graphql.json`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  const QUERY = `query($cursor:String,$q:String){
    products(first:250, after:$cursor, query:$q){
      pageInfo{ hasNextPage endCursor }
      edges{ node{ id } }
    }
  }`;
  const ids = new Set();
  let cursor = null, hasNext = true;
  while (hasNext) {
    const data = await c.request(QUERY, { cursor, q: "status:active" });
    for (const e of data.products.edges) {
      ids.add(e.node.id.replace("gid://shopify/Product/", ""));
    }
    hasNext = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }
  return ids;
}

// Heuristic: returns true if obj looks like a product reference
function isProductRef(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.id == null) return false;
  // Numeric id and either a handle or product_handle
  if (typeof obj.id !== "number" && !/^\d+$/.test(String(obj.id))) return false;
  return obj.handle != null || obj.product_handle != null;
}

// Recursively walk obj, filter out arrays of product refs whose id is not in activeIds.
// Returns total number of removed entries.
function pruneDeletedProducts(obj, activeIds) {
  let removed = 0;
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      const el = obj[i];
      if (isProductRef(el) && !activeIds.has(String(el.id))) {
        obj.splice(i, 1);
        removed++;
      } else if (typeof el === "object" && el !== null) {
        removed += pruneDeletedProducts(el, activeIds);
      }
    }
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      if (typeof val === "object" && val !== null) {
        removed += pruneDeletedProducts(val, activeIds);
      }
    }
  }
  return removed;
}

async function processStore(shop) {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("STORE: " + shop + (dryRun ? "  (DRY RUN)" : ""));
  console.log("═══════════════════════════════════════════════════");

  console.log("[1] Fetching active Shopify product IDs...");
  const activeIds = await fetchActiveShopifyIds(shop);
  console.log("    " + activeIds.size + " active Shopify products");

  console.log("[2] Scanning cache & pruning deleted product refs...");
  let scanned = 0, modified = 0, totalRemoved = 0, errors = 0;
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
    for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
      const chunk = items.slice(i, i + BATCH_CONCURRENCY);
      await Promise.all(chunk.map(async (item) => {
        try {
          scanned++;
          if (!item.data) return;
          const removed = pruneDeletedProducts(item.data, activeIds);
          if (removed > 0) {
            modified++;
            totalRemoved += removed;
            if (!dryRun) {
              await ddb.put({ TableName: "CacheTable", Item: item }).promise();
            }
          }
        } catch (e) {
          errors++;
        }
      }));
    }

    lastEvalKey = res.LastEvaluatedKey;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`    scanned ${scanned}, items modified ${modified}, refs removed ${totalRemoved} (${elapsed}s)\r`);
  } while (lastEvalKey);

  console.log(`\n    ─────────────────────────────────────────`);
  console.log(`    Total cache items scanned: ${scanned}`);
  console.log(`    Cache items modified:      ${modified}`);
  console.log(`    Deleted product refs removed: ${totalRemoved}`);
  if (errors > 0) console.log(`    Errors:                    ${errors}`);
  console.log(`    Elapsed:                   ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
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
