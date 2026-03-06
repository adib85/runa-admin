#!/usr/bin/env node

/**
 * Lambda Similar Products Processor
 * Fetches products from Neo4j and refreshes "Similar Products" widgets
 * by clearing cache, calling the similar-products Lambda, and updating timestamps.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-lambda-similar-products.js <storeId> [options]
 *
 *   Options:
 *     --batchSize <n>      Number of parallel requests (default: 10)
 *     --maxProducts <n>    Max products to process (default: unlimited)
 *     --startFrom <n>      Starting offset (default: 0)
 *     --delay <ms>         Delay between requests in ms (default: 2000)
 *
 *   Examples:
 *     node apps/api/src/scripts/sync-lambda-similar.js toffro.vtexcommercestable.com.br
 *     node apps/api/src/scripts/sync-lambda-similar.js mystore.myshopify.com --batchSize 5 --maxProducts 50
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
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

const SIMILAR_PRODUCTS_LAMBDA_URL = "https://ztqjtsoqzv5jgmv2v55jnrqokq0klhwg.lambda-url.us-east-1.on.aws/";

AWS.config.update({ region: AWS_REGION });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── DynamoDB: delete similar products cache ─────────────────────────

async function deleteSimilarProductsCache(productHandle, storeId, languages = ["en"]) {
  try {
    const deletions = languages.map(language => {
      const cacheId = `${storeId.toLowerCase()}_similar_products_${productHandle.toLowerCase()}_${language}`;
      console.log(`   Deleting similar products cache: ${cacheId}`);

      return dynamodb
        .delete({ TableName: CACHE_TABLE, Key: { id: cacheId } })
        .promise()
        .then(() => ({ success: true, cacheId }))
        .catch(error => ({ success: false, cacheId, error: error.message }));
    });

    const results = await Promise.all(deletions);
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`   Similar products cache deletion: ${successful} ok, ${failed} failed`);

    if (failed > 0) {
      console.error(`   Failed deletions:`, results.filter(r => !r.success));
    }

    return { success: failed === 0, total: results.length, successful, failed, results };
  } catch (error) {
    console.error(`   Error deleting similar products cache:`, error);
    throw error;
  }
}

// ─── Lambda: refresh similar products widget ─────────────────────────

async function refreshSimilarProductsWidget(productHandle, storeId) {
  const url = `${SIMILAR_PRODUCTS_LAMBDA_URL}?domain=${storeId}&productHandle=${productHandle}&mode=similar`;

  try {
    console.log(`   Refreshing similar products widget...`);

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`   Similar products widget refreshed (${duration}ms)`);

    return { success: true, duration, url, data };
  } catch (error) {
    console.error(`   Error refreshing similar products widget: ${error.message}`);
    return { success: false, error: error.message, url };
  }
}

// ─── Neo4j helpers ───────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function updateSimilarProductTimestamp(productId, storeId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    const result = await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.similar_product_updated_at = $updatedAt
       RETURN p.id as id, p.similar_product_updated_at as similar_product_updated_at`,
      { productId, storeId, updatedAt: now }
    );

    if (result.records.length === 0) {
      console.error(`   Product not found: ${productId} in store ${storeId}`);
      return { success: false, message: "Product not found" };
    }

    console.log(`   similar_product_updated_at timestamp updated in Neo4j`);
    return {
      success: true,
      productId,
      similar_product_updated_at: result.records[0].get("similar_product_updated_at")
    };
  } catch (error) {
    console.error(`   Error updating timestamp in Neo4j:`, error);
    throw error;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function getProductById(productId, storeId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       RETURN p.id as id, p.title as title, p.handle as handle, p.storeId as storeId`,
      { productId, storeId }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return { id: r.get("id"), title: r.get("title"), handle: r.get("handle"), storeId: r.get("storeId") };
  } catch (error) {
    console.error("Error fetching product:", error);
    throw error;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function countStoreProducts(storeId, hoursAgo = null, missingOnly = false) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const timeFilter = hoursAgo
      ? `AND p.updated_at IS NOT NULL AND datetime(p.updated_at) >= datetime() - duration('PT${hoursAgo}H')`
      : "";
    const missingFilter = missingOnly
      ? `AND p.similar_product_updated_at IS NULL`
      : "";
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${timeFilter}
         ${missingFilter}
       RETURN count(p) as total`,
      { storeId }
    );
    return result.records[0].get("total").toInt();
  } catch (error) {
    console.error("Error counting products:", error);
    return 0;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function fetchProductsBatch(storeId, skip, limit, hoursAgo = null, missingOnly = false) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const timeFilter = hoursAgo
      ? `AND p.updated_at IS NOT NULL AND datetime(p.updated_at) >= datetime() - duration('PT${hoursAgo}H')`
      : "";
    const missingFilter = missingOnly
      ? `AND p.similar_product_updated_at IS NULL`
      : "";
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${timeFilter}
         ${missingFilter}
       RETURN p.id as id, p.title as title, p.handle as handle, p.storeId as storeId
       ORDER BY p.updated_at DESC
       SKIP $skip
       LIMIT $limit`,
      { storeId, skip: neo4j.int(skip), limit: neo4j.int(limit) }
    );
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      storeId: r.get("storeId")
    }));
  } catch (error) {
    console.error("Error fetching products batch:", error);
    throw error;
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Single product processor ────────────────────────────────────────

async function processSimilarProductsForProduct(product) {
  console.log(`\n   [${product.id}] ${product.title}`);
  console.log(`   Handle: ${product.handle}`);
  console.log(`   Store/Domain: ${product.storeId}`);

  try {
    const startTime = Date.now();

    await deleteSimilarProductsCache(product.handle, product.storeId);

    const similarResult = await refreshSimilarProductsWidget(product.handle, product.storeId);

    if (similarResult.success) {
      await updateSimilarProductTimestamp(product.id, product.storeId);
    }

    const duration = Date.now() - startTime;
    console.log(`   Complete (${duration}ms)`);

    return { status: "success", product, duration, similarProducts: similarResult };
  } catch (error) {
    console.error(`   Error: ${error.message}`);
    return { status: "error", product, error: error.message };
  }
}

// ─── Main batch processor ────────────────────────────────────────────

async function processSimilarProductsRecent(storeId, options = {}) {
  const {
    batchSize = 10,
    maxProducts = null,
    startFrom = 0,
    hoursAgo = 24,
    missingOnly = false,
    delayBetweenRequests = 2000
  } = options;

  console.log("\n========================================");
  console.log("SIMILAR PRODUCTS PROCESSOR");
  console.log("========================================");
  console.log(`Store ID: ${storeId}`);
  console.log(`Mode: ${missingOnly ? "MISSING ONLY" : hoursAgo ? `last ${hoursAgo} hours` : "ALL products"}`);
  console.log(`Batch size: ${batchSize} (parallel requests)`);
  console.log(`Max products: ${maxProducts || "UNLIMITED"}`);
  console.log(`Starting from: ${startFrom}`);
  console.log(`Delay between requests: ${delayBetweenRequests}ms`);
  console.log("========================================\n");

  console.log("Counting products...");
  const totalProducts = await countStoreProducts(storeId, hoursAgo, missingOnly);
  console.log(`Total products to process: ${totalProducts}\n`);

  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let totalDuration = 0;
  let skip = startFrom;

  const results = { successful: [], errors: [] };

  try {
    while (true) {
      if (maxProducts && processedCount >= maxProducts) {
        console.log(`\nReached maximum product limit: ${maxProducts}`);
        break;
      }

      console.log(`\n--- Fetching batch (skip: ${skip}, limit: ${batchSize}) ---`);
      const products = await fetchProductsBatch(storeId, skip, batchSize, hoursAgo, missingOnly);

      if (products.length === 0) {
        console.log("No more products to process");
        break;
      }

      console.log(`Fetched ${products.length} products`);
      console.log(`Processing batch with ${delayBetweenRequests}ms stagger...\n`);

      const batchPromises = [];
      for (let i = 0; i < products.length; i++) {
        const promise = processSimilarProductsForProduct(products[i]);
        batchPromises.push(promise);

        if (i < products.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
        }
      }

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach(promiseResult => {
        processedCount++;

        if (promiseResult.status === "fulfilled") {
          const result = promiseResult.value;

          if (result.status === "success") {
            successCount++;
            totalDuration += result.duration || 0;
            results.successful.push({
              productId: result.product.id,
              productTitle: result.product.title,
              handle: result.product.handle,
              duration: result.duration,
              similarProducts: result.similarProducts
            });
          } else if (result.status === "error") {
            errorCount++;
            results.errors.push({
              productId: result.product.id,
              productTitle: result.product.title,
              handle: result.product.handle,
              error: result.error
            });
          }
        } else {
          errorCount++;
          results.errors.push({
            error: promiseResult.reason?.message || "Unknown error"
          });
        }
      });

      console.log(`\nBatch complete: ${successCount} successful, ${errorCount} errors`);

      if (maxProducts && processedCount >= maxProducts) {
        console.log(`\nReached maximum product limit: ${maxProducts}`);
        break;
      }

      if (!missingOnly) {
        skip += batchSize;
      }
    }
  } catch (error) {
    console.error("\nFatal error during processing:", error);
  }

  console.log("\n========================================");
  console.log("PROCESSING COMPLETE");
  console.log("========================================");
  console.log(`Total processed: ${processedCount}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  if (successCount > 0) {
    console.log(`\nAvg duration per request: ${(totalDuration / successCount).toFixed(0)}ms`);
    console.log(`Total duration: ${(totalDuration / 1000).toFixed(2)}s`);
  }

  if (results.errors.length > 0) {
    console.log(`\nErrors (${results.errors.length}):`);
    results.errors.forEach((err, idx) => {
      console.log(`  ${idx + 1}. ${err.productTitle || "Unknown"} (${err.productId || "N/A"}): ${err.error}`);
    });
  }

  console.log("========================================\n");

  return {
    processedCount,
    successCount,
    errorCount,
    averageDuration: successCount > 0 ? totalDuration / successCount : 0,
    results
  };
}

// ─── Exports ─────────────────────────────────────────────────────────

export {
  processSimilarProductsRecent,
  processSimilarProductsForProduct,
  getProductById,
  fetchProductsBatch,
  countStoreProducts,
  deleteSimilarProductsCache,
  refreshSimilarProductsWidget,
  updateSimilarProductTimestamp
};

export default processSimilarProductsRecent;

// ─── CLI entry point ─────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node sync-lambda-similar-products.js <storeId> [options]");
  console.error("  Options:");
  console.error("    --batchSize <n>      Number of parallel requests (default: 10)");
  console.error("    --maxProducts <n>    Max products to process (default: unlimited)");
  console.error("    --startFrom <n>      Starting offset (default: 0)");
  console.error("    --hours <n>          Only products updated in last N hours (default: 24)");
  console.error("    --all                Process ALL products regardless of updated_at");
  console.error("    --missing            Only products missing similar_product_updated_at");
  console.error("    --delay <ms>         Delay between requests in ms (default: 1000)");
  process.exit(1);
}

function parseCliArgs(argv) {
  const storeId = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { storeId, opts };
}

const { storeId: cliStoreId, opts: cliOpts } = parseCliArgs(args);

const batchSize = parseInt(cliOpts.batchSize) || 50;
const maxProducts = cliOpts.maxProducts ? parseInt(cliOpts.maxProducts) : null;
const startFrom = parseInt(cliOpts.startFrom) || 0;
const hoursAgo = args.includes("--all") || args.includes("--missing") ? null : (parseInt(cliOpts.hours) || 24);
const missingOnly = args.includes("--missing");
const delayBetweenRequests = parseInt(cliOpts.delay) || 1000;

(async () => {
  try {
    const result = await processSimilarProductsRecent(cliStoreId, {
      batchSize,
      maxProducts,
      startFrom,
      hoursAgo,
      missingOnly,
      delayBetweenRequests
    });
    console.log(`\nDone. Processed: ${result.processedCount}, Success: ${result.successCount}, Errors: ${result.errorCount}`);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
})();
