#!/usr/bin/env node

/**
 * Toff (VTEX) Price-Only Sync — DynamoDB CacheTable only
 *
 * Refreshes per-product price entries in the DynamoDB CacheTable. The backend
 * reconciles prices from this cache (read pattern: handlerCompleteTheLookFD.js
 * et al. — batchGet by key `${storeId}_product_${productId}` and read
 * item.product.price / item.product.price_old).
 *
 * Flow:
 *   1. MATCH product IDs from Neo4j for this store (only products we have indexed)
 *   2. Chunk into groups of 25 → GET /api/catalog_system/pub/products/search?fq=productId:X,...
 *   3. Extract canonical price (first available SKU's offer)
 *   4. BatchWrite item shape { id, productId, storeId, product: { price, price_old }, updatedAt }
 *
 * Neo4j is used READ-ONLY (to enumerate indexed products); the script never
 * writes to Neo4j. Product/variant price properties are owned by the daily
 * full sync at sync-modular.js.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-toff-prices.js <account> <app-key> <app-token> [flags]
 *
 * Example:
 *   node apps/api/src/scripts/sync-toff-prices.js toffro vtexappkey-xxx TOKEN
 *
 * Flags:
 *   --max <n>     Stop after fetching N products (for testing)
 *   --dry-run     Skip DynamoDB writes; log only
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import neo4j from "neo4j-driver";
import AWS from "aws-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

const DETAIL_BATCH_SIZE = 25;
const DETAIL_BATCH_DELAY_MS = 300;
const MAX_RETRIES = 5;
const CACHE_TABLE = "CacheTable";
const DDB_BATCH_SIZE = 25; // DynamoDB batchWrite max

AWS.config.update({ region: AWS_REGION });

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const flagsWithValues = new Set(["--max"]);
  const dryRun = argv.includes("--dry-run");
  const maxIdx = argv.indexOf("--max");
  const max = maxIdx !== -1 ? parseInt(argv[maxIdx + 1], 10) : null;
  const positional = argv.filter((a, i) =>
    !a.startsWith("--") && !flagsWithValues.has(argv[i - 1])
  );

  const [accountName, appKey, appToken] = positional;
  if (!accountName || !appKey || !appToken) {
    console.error(`
Usage: node sync-toff-prices.js <account> <app-key> <app-token> [--max N] [--dry-run]

Arguments:
  account     VTEX account name (e.g. "toffro")
  app-key     X-VTEX-API-AppKey value
  app-token   X-VTEX-API-AppToken value

Flags:
  --max N     Stop after fetching N products (testing)
  --dry-run   Skip DynamoDB writes; log only
`);
    process.exit(1);
  }

  return { accountName, appKey, appToken, dryRun, max };
}

async function vtexRequest({ baseUrl, endpoint, headers, returnHeaders }) {
  const url = `${baseUrl}${endpoint}`;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", headers });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 60000);
        console.log(`  [VTEX] 429 rate-limited, waiting ${(wait / 1000).toFixed(1)}s (retry ${attempt + 1}/${MAX_RETRIES})`);
        await delay(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`VTEX ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      if (returnHeaders) {
        return { json, headers: Object.fromEntries(res.headers.entries()) };
      }
      return json;
    } catch (err) {
      lastErr = err;
      if ((err.code === "ECONNRESET" || err.code === "ETIMEDOUT") && attempt < MAX_RETRIES) {
        const wait = Math.min(2000 * 2 ** attempt, 30000);
        console.log(`  [VTEX] ${err.code}, retrying in ${(wait / 1000).toFixed(1)}s`);
        await delay(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("VTEX request exhausted retries");
}

// Match VtexProvider.transformSearchProduct semantics (vtex.js:599-600):
//   price     = Price || ListPrice
//   price_old = ListPrice || PriceWithoutDiscount
function pickPrices(offer) {
  const rawPrice = offer.Price || offer.ListPrice || 0;
  if (!rawPrice || rawPrice <= 0) return null;
  const rawPriceOld = offer.ListPrice || offer.PriceWithoutDiscount || rawPrice;
  return { price: String(rawPrice), price_old: String(rawPriceOld) };
}

// Extract one canonical price per VTEX product. Selection rule mirrors
// transformSearchProduct (vtex.js:582-594): first available SKU's available
// seller, falling back to the first SKU/seller if nothing is available.
function extractProductPrice(product) {
  const availableItems = (product.items || []).filter(item =>
    item.sellers?.some(s => s.commertialOffer?.IsAvailable)
  );
  const mainItem = availableItems[0] || product.items?.[0];
  if (!mainItem) return null;

  const seller =
    mainItem.sellers?.find(s => s.commertialOffer?.IsAvailable) ||
    mainItem.sellers?.[0];
  const prices = pickPrices(seller?.commertialOffer || {});
  if (!prices) return null;

  return { id: String(product.productId), ...prices };
}

// Upsert per-product price entries into the DynamoDB CacheTable used by the
// widget Lambdas at key `${storeId}_product_${productId}`. Shape matches the
// Lambda reader (item.product.price + item.product.price_old).
async function upsertCacheEntries(docClient, storeId, products) {
  if (products.length === 0) return 0;
  const now = Date.now();
  let written = 0;

  for (let i = 0; i < products.length; i += DDB_BATCH_SIZE) {
    const chunk = products.slice(i, i + DDB_BATCH_SIZE);
    let requestItems = {
      [CACHE_TABLE]: chunk.map(pp => ({
        PutRequest: {
          Item: {
            id: `${storeId}_product_${pp.id}`,
            productId: pp.id,
            storeId,
            product: { price: pp.price, price_old: pp.price_old },
            updatedAt: now
          }
        }
      }))
    };

    // Honor UnprocessedItems with capped retries (BatchWrite can return some
    // items unprocessed under throttling).
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await docClient.batchWrite({ RequestItems: requestItems }).promise();
      const submitted = requestItems[CACHE_TABLE]?.length || 0;
      const unprocessed = res.UnprocessedItems?.[CACHE_TABLE] || [];
      written += submitted - unprocessed.length;
      if (unprocessed.length === 0) break;
      const wait = Math.min(1000 * 2 ** attempt, 15000);
      console.log(`  [DDB] ${unprocessed.length} unprocessed, retrying in ${(wait / 1000).toFixed(1)}s`);
      await delay(wait);
      requestItems = { [CACHE_TABLE]: unprocessed };
    }
  }

  return written;
}

// Read the list of Product.id values indexed for this store. The price sync
// only needs to refresh prices for products that are actually in Neo4j —
// fetching the entire VTEX catalog (which is ~85% larger than what we index)
// would be wasted API calls.
async function getStoreProductIds(driver, storeId) {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       RETURN p.id AS id`,
      { storeId }
    );
    return result.records.map(r => String(r.get("id"))).filter(Boolean);
  } finally {
    await session.close();
  }
}

async function main() {
  const { accountName, appKey, appToken, dryRun, max } = parseArgs();
  const baseUrl = `https://${accountName}.vtexcommercestable.com.br`;
  const storeId = `${accountName}.vtexcommercestable.com.br`;
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-VTEX-API-AppKey": appKey,
    "X-VTEX-API-AppToken": appToken
  };
  const writeCache = !dryRun;

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Toff Price Sync — ${accountName}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  baseUrl:    ${baseUrl}`);
  console.log(`  storeId:    ${storeId}`);
  console.log(`  dryRun:     ${dryRun}`);
  console.log(`  target:     DynamoDB CacheTable (Neo4j read-only)`);
  if (max !== null) console.log(`  max:        ${max}`);
  console.log("");

  // Neo4j is opened read-only: we only enumerate indexed product IDs from it.
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const docClient = writeCache
    ? new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true })
    : null;

  const stats = {
    batches: 0,
    productsRequested: 0,
    productsFetched: 0,
    productsWithPrice: 0,
    productsOnSale: 0,
    cacheWritten: 0,
    errors: 0
  };

  try {
    // ── Get the list of product IDs we have indexed for this store
    console.log(`  [Neo4j] fetching indexed product IDs for ${storeId}...`);
    let allProductIds = await getStoreProductIds(driver, storeId);
    console.log(`  [Neo4j] ${allProductIds.length} products indexed in Neo4j\n`);

    if (max !== null && allProductIds.length > max) {
      allProductIds = allProductIds.slice(0, max);
      console.log(`  [--max ${max}] truncated to ${allProductIds.length} products\n`);
    }

    // ── Walk product IDs in chunks of DETAIL_BATCH_SIZE
    for (let i = 0; i < allProductIds.length; i += DETAIL_BATCH_SIZE) {
      const chunk = allProductIds.slice(i, i + DETAIL_BATCH_SIZE);
      stats.batches++;
      stats.productsRequested += chunk.length;

      const fq = chunk.map(id => `productId:${id}`).join(",");
      const endpoint = `/api/catalog_system/pub/products/search?fq=${encodeURIComponent(fq)}`;

      const pageProducts = [];
      try {
        const products = await vtexRequest({ baseUrl, endpoint, headers });
        for (const p of products) {
          stats.productsFetched++;
          const priced = extractProductPrice(p);
          if (!priced) continue;
          pageProducts.push(priced);
          if (Number(priced.price_old) > Number(priced.price)) {
            stats.productsOnSale++;
          }
        }
      } catch (err) {
        console.warn(`  [VTEX] detail chunk failed (${chunk.length} ids): ${err.message}`);
        stats.errors++;
      }

      stats.productsWithPrice += pageProducts.length;

      const pct = ((i + chunk.length) / allProductIds.length * 100).toFixed(1);
      console.log(`  [VTEX] batch ${stats.batches} (${i + chunk.length}/${allProductIds.length} — ${pct}%): ${pageProducts.length}/${chunk.length} priced`);

      // ── Write to DDB CacheTable
      if (pageProducts.length > 0) {
        if (dryRun) {
          console.log(`  [DRY] would write ${pageProducts.length} DDB cache entries`);
          if (stats.batches <= 2) {
            console.log(`  [DRY] sample:`, pageProducts[0]);
          }
        } else {
          try {
            const cWritten = await upsertCacheEntries(docClient, storeId, pageProducts);
            stats.cacheWritten += cWritten;
            console.log(`  [DDB]   wrote ${cWritten}/${pageProducts.length} cache entries`);
          } catch (err) {
            console.error(`  [DDB] cache write failed: ${err.message}`);
            stats.errors++;
          }
        }
      }

      await delay(DETAIL_BATCH_DELAY_MS);
    }
  } finally {
    await driver.close();
  }

  console.log("\n  ════════════════════════════════════════════════════════════");
  console.log("  Toff Price Sync — DONE");
  console.log(`    batches:              ${stats.batches}`);
  console.log(`    products requested:   ${stats.productsRequested}`);
  console.log(`    products fetched:     ${stats.productsFetched}`);
  console.log(`    products with price:  ${stats.productsWithPrice}`);
  console.log(`    products ON SALE:     ${stats.productsOnSale} (${stats.productsWithPrice > 0 ? ((stats.productsOnSale / stats.productsWithPrice) * 100).toFixed(1) : 0}%)`);
  console.log(`    DDB cache written:    ${stats.cacheWritten}`);
  console.log(`    errors:               ${stats.errors}`);
  console.log("  ════════════════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error("Toff price sync failed:", err);
  process.exit(1);
});
