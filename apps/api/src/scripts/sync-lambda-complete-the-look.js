#!/usr/bin/env node

/**
 * Lambda Complete The Look Processor
 * Fetches products from Neo4j and generates "Complete The Look" widgets
 * by clearing cache and calling the outfit-generation Lambda with staggered batches.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-lambda-complete-the-look.js <storeId> [options]
 *
 *   Options:
 *     --batchSize <n>      Number of parallel requests (default: 10)
 *     --maxProducts <n>    Max products to process (default: unlimited)
 *     --startFrom <n>      Starting offset (default: 0)
 *     --language <lang>    Language code (default: en)
 *
 *   Examples:
 *     node apps/api/src/scripts/sync-lambda-recent.js toffro.vtexcommercestable.com.br
 *     node apps/api/src/scripts/sync-lambda-recent.js mystore.myshopify.com --batchSize 5 --maxProducts 50
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import crypto from "crypto";
import AWS from "aws-sdk";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

const LAMBDA_URL_BASE = "https://7gduqkaho5pvkb6rfvfcfeg6ca0ymnid.lambda-url.us-east-1.on.aws/";

AWS.config.update({ region: AWS_REGION });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── DynamoDB: delete cache ──────────────────────────────────────────

async function deleteCacheItem(productHandle, storeId, languages = ["en"]) {
  try {
    const deletions = languages.map(language => {
      const cacheId = `${storeId}_${productHandle}_${language}`;
      console.log(`   Deleting cache: ${cacheId}`);

      return dynamodb
        .delete({ TableName: CACHE_TABLE, Key: { id: cacheId } })
        .promise()
        .then(() => ({ success: true, cacheId }))
        .catch(error => ({ success: false, cacheId, error: error.message }));
    });

    const results = await Promise.all(deletions);
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`   Cache deletion: ${successful} ok, ${failed} failed`);

    if (failed > 0) {
      console.error(`   Failed deletions:`, results.filter(r => !r.success));
    }

    return { success: failed === 0, total: results.length, successful, failed, results };
  } catch (error) {
    console.error(`   Error deleting cache items:`, error);
    throw error;
  }
}

// ─── Neo4j helpers ───────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
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

async function countStoreProducts(storeId, hoursAgo = null, missingOnly = false, reindexOnly = false) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const timeFilter = hoursAgo
      ? `AND p.updated_at IS NOT NULL AND datetime(p.updated_at) >= datetime() - duration('PT${hoursAgo}H')`
      : "";
    const missingFilter = missingOnly
      ? `AND p.complete_the_look_updated_at IS NULL`
      : "";
    const reindexFilter = reindexOnly
      ? `AND p.needs_reindex = true`
      : "";
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${timeFilter}
         ${missingFilter}
         ${reindexFilter}
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

async function fetchProductsBatch(storeId, skip, limit, hoursAgo = null, missingOnly = false, reindexOnly = false) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const timeFilter = hoursAgo
      ? `AND p.updated_at IS NOT NULL AND datetime(p.updated_at) >= datetime() - duration('PT${hoursAgo}H')`
      : "";
    const missingFilter = missingOnly
      ? `AND p.complete_the_look_updated_at IS NULL`
      : "";
    const reindexFilter = reindexOnly
      ? `AND p.needs_reindex = true`
      : "";
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${timeFilter}
         ${missingFilter}
         ${reindexFilter}
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

async function updateCompleteTheLookTimestamp(productId, storeId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    const result = await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.complete_the_look_updated_at = $updatedAt
       RETURN p.id as id, p.complete_the_look_updated_at as complete_the_look_updated_at`,
      { productId, storeId, updatedAt: now }
    );

    if (result.records.length === 0) {
      console.error(`   Product not found: ${productId} in store ${storeId}`);
      return { success: false, message: "Product not found" };
    }

    console.log(`   complete_the_look_updated_at timestamp updated in Neo4j`);
    return {
      success: true,
      productId,
      complete_the_look_updated_at: result.records[0].get("complete_the_look_updated_at")
    };
  } catch (error) {
    console.error(`   Error updating timestamp in Neo4j:`, error);
    throw error;
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Lambda URL builder ──────────────────────────────────────────────

function buildLambdaUrl(product, options = {}) {
  const {
    userId = "default-2",
    personality = "classic, romantic",
    chromatic = "autumn",
    isNeutral = 0,
    action = "gpt-4",
    tokens = 1024,
    temperature = 1,
    model1 = "",
    model2 = "",
    skipCaching = false,
    profileId = "",
    language = "en",
    skipImages = false
  } = options;

  const channelId = `runa_${product.storeId}_${crypto.randomUUID()}-outfit`;
  const actionId = crypto.randomUUID();

  const params = new URLSearchParams({
    userId,
    domain: product.storeId,
    productId: product.id,
    personality,
    chromatic,
    isNeutral,
    channelId,
    action,
    actionId,
    tokens,
    temperature,
    model1,
    model2,
    skipCaching,
    productHandle: product.handle,
    profileId,
    language,
    ...(options.geminiModel ? { geminiModel: options.geminiModel } : {}),
    ...(skipImages ? { skipImages: "true" } : {})
  });

  return `${LAMBDA_URL_BASE}?${params.toString()}`;
}

// ─── Single product processor ────────────────────────────────────────

async function processProductWithLambda(product, options = {}) {
  const url = buildLambdaUrl(product, options);

  console.log(`   [${product.id}] ${product.title}`);
  console.log(`   Handle: ${product.handle}`);
  console.log(`   Store/Domain: ${product.storeId}`);

  await deleteCacheItem(product.handle, product.storeId);
  console.log(`   Cache item deleted for product ${product.id}`);

  try {
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
    console.log(`   Success (${duration}ms)`);

    await updateCompleteTheLookTimestamp(product.id, product.storeId);

    return { status: "success", product, data, duration, url };
  } catch (error) {
    console.error(`   Error: ${error.message}`);
    return { status: "error", product, error: error.message, url };
  }
}

// ─── Main batch processor ────────────────────────────────────────────

async function processStoreProductsWithLambda(storeId, options = {}) {
  const {
    batchSize = 10,
    maxProducts = null,
    startFrom = 0,
    hoursAgo = 24,
    missingOnly = false,
    reindexOnly = false,
    lambdaOptions = {}
  } = options;

  console.log("\n========================================");
  console.log("COMPLETE THE LOOK PROCESSOR");
  console.log("========================================");
  console.log(`Store ID: ${storeId}`);
  console.log(`Mode: ${reindexOnly ? "REINDEX (needs_reindex=true)" : missingOnly ? "MISSING ONLY" : hoursAgo ? `last ${hoursAgo} hours` : "ALL products"}`);
  console.log(`Batch size: ${batchSize} (parallel requests)`);
  console.log(`Max products: ${maxProducts || "UNLIMITED"}`);
  console.log(`Starting from: ${startFrom}`);
  console.log("========================================\n");

  console.log("Counting products...");
  const totalProducts = await countStoreProducts(storeId, hoursAgo, missingOnly, reindexOnly);
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
      const products = await fetchProductsBatch(storeId, skip, batchSize, hoursAgo, missingOnly, reindexOnly);

      if (products.length === 0) {
        console.log("No more products to process");
        break;
      }

      console.log(`Fetched ${products.length} products`);
      console.log(`Processing batch with 2s stagger...\n`);

      const batchPromises = [];
      for (let i = 0; i < products.length; i++) {
        const promise = processProductWithLambda(products[i], lambdaOptions);
        batchPromises.push(promise);

        if (i < products.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach(promiseResult => {
        processedCount++;

        if (promiseResult.status === "fulfilled") {
          const result = promiseResult.value;

          if (result.status === "success") {
            successCount++;
            totalDuration += result.duration;
            results.successful.push({
              productId: result.product.id,
              productTitle: result.product.title,
              handle: result.product.handle,
              duration: result.duration,
              url: result.url,
              response: result.data
            });
          } else if (result.status === "error") {
            errorCount++;
            results.errors.push({
              productId: result.product.id,
              productTitle: result.product.title,
              handle: result.product.handle,
              error: result.error,
              url: result.url
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
  processStoreProductsWithLambda,
  processProductWithLambda,
  getProductById,
  fetchProductsBatch,
  countStoreProducts,
  buildLambdaUrl,
  deleteCacheItem,
  updateCompleteTheLookTimestamp
};

export default processStoreProductsWithLambda;

// ─── CLI entry point ─────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node sync-lambda-complete-the-look.js <storeId> [options]");
  console.error("  Options:");
  console.error("    --batchSize <n>      Number of parallel requests (default: 10)");
  console.error("    --maxProducts <n>    Max products to process (default: unlimited)");
  console.error("    --startFrom <n>      Starting offset (default: 0)");
  console.error("    --hours <n>          Only products updated in last N hours (default: 24)");
  console.error("    --all                Process ALL products regardless of updated_at");
  console.error("    --missing            Only products missing complete_the_look_updated_at");
  console.error("    --reindex            Only products flagged with needs_reindex=true");
  console.error("    --language <lang>    Language code (default: en)");
  console.error("    --skip-images        Do not send product images to the Lambda");
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

const batchSize = parseInt(cliOpts.batchSize) || 40;
const maxProducts = cliOpts.maxProducts ? parseInt(cliOpts.maxProducts) : null;
const startFrom = parseInt(cliOpts.startFrom) || 0;
const reindexOnly = args.includes("--reindex");
const hoursAgo = args.includes("--all") || args.includes("--missing") || reindexOnly ? null : (parseInt(cliOpts.hours) || 24);
const missingOnly = args.includes("--missing");
const language = cliOpts.language || "en";
const geminiModel = cliOpts["gemini-model"] || null;
const skipImages = args.includes("--skip-images");

(async () => {
  try {
    const result = await processStoreProductsWithLambda(cliStoreId, {
      batchSize,
      maxProducts,
      startFrom,
      hoursAgo,
      missingOnly,
      reindexOnly,
      lambdaOptions: {
        userId: "default-2",
        personality: "classic, romantic",
        chromatic: "autumn",
        isNeutral: 0,
        action: "gpt-4",
        tokens: 1024,
        temperature: 1,
        language,
        geminiModel,
        skipImages
      }
    });
    console.log(`\nDone. Processed: ${result.processedCount}, Success: ${result.successCount}, Errors: ${result.errorCount}`);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
})();
