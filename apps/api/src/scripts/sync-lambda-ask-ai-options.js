#!/usr/bin/env node

/**
 * Lambda Ask AI Options Processor
 *
 * Fetches products from Neo4j and refreshes the standalone "Ask AI" chip
 * suggestions by clearing the dedicated DynamoDB cache item, calling the
 * ask-ai Lambda, and stamping a timestamp on the product node.
 *
 * Pattern mirrors `sync-lambda-similar-products.js` exactly.
 *
 * Endpoint (declared in `src/pdpWidgets/api.js:14` as AI_STYLIST_URL):
 *   GET https://376jtm5kvrmblt45jdduztivku0odqxn.lambda-url.us-east-1.on.aws/
 *       ?domain=<storeId>&handle=<productHandle>
 *       [&skipCaching=true]
 *       [&geminiModel=<name>]
 *
 * Response shape:
 *   { "data": { "userOptions": ["Question 1", "Question 2", ...] } }
 *
 * Cache item the Lambda is expected to fill (consistent with other Bronze
 * Snake cache keys like `_similar_products_`):
 *   `<storeId>_userOptions_<handle>_<lang>`
 *
 * Usage:
 *   node apps/api/src/scripts/sync-lambda-ask-ai-options.js <storeId> [options]
 *
 *   Options:
 *     --batchSize <n>      Number of parallel requests (default: 10)
 *     --maxProducts <n>    Max products to process (default: unlimited)
 *     --startFrom <n>      Starting offset (default: 0)
 *     --hours <n>          Only products updated in last N hours (default: 24)
 *     --all                Process ALL products regardless of updated_at
 *     --missing            Only products missing ask_ai_options_updated_at
 *     --reindex            Only products flagged with needs_reindex=true
 *     --delay <ms>         Delay between requests in ms (default: 100)
 *     --skip-caching       Pass skipCaching=true to the Lambda
 *     --gemini-model <m>   Pin a specific Gemini model in the Lambda call
 *
 *   Examples:
 *     node apps/api/src/scripts/sync-lambda-ask-ai-options.js bronze-snake-1.myshopify.com --missing
 *     node apps/api/src/scripts/sync-lambda-ask-ai-options.js bronze-snake-1.myshopify.com --batchSize 5 --maxProducts 50
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

const ASK_AI_LAMBDA_URL = "https://376jtm5kvrmblt45jdduztivku0odqxn.lambda-url.us-east-1.on.aws/";

AWS.config.update({ region: AWS_REGION });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── DynamoDB: cache key + helpers ───────────────────────────────────
//
// The AI_STYLIST_URL Lambda DOES cache to DynamoDB, but only when:
//   - `skipCaching` is false (default)
//   - `userOptions.length === 3` in the response
// And it uses the `language` query param (default "ro") as the suffix
// of the cache key. We pass `language=en` from `refreshAskAiOptions`
// so the Lambda's own write lands at the same key our writer reads
// from. As an extra safety net (and to cover the `--skip-caching`
// path where the Lambda skips its own write), this generator also
// `put`s the chips itself via `writeAskAiCache` after each Lambda
// call. The two writes are idempotent.
//
// Cache shape mirrors the CTL/Similar items so the existing
// cache-fanout / cleanup-stale tools recognise it:
//   id      = `<storeId>_userOptions_<handle>_<lang>`
//   storeId = <storeId>
//   data    = { userOptions: [string, ...] }

function buildAskAiCacheKey(handle, storeId, language = "en") {
  return `${storeId.toLowerCase()}_userOptions_${String(handle).toLowerCase()}_${language}`;
}

async function deleteAskAiCache(productHandle, storeId, languages = ["en"]) {
  try {
    const deletions = languages.map(language => {
      const cacheId = buildAskAiCacheKey(productHandle, storeId, language);
      console.log(`   Deleting ask-ai cache: ${cacheId}`);

      return dynamodb
        .delete({ TableName: CACHE_TABLE, Key: { id: cacheId } })
        .promise()
        .then(() => ({ success: true, cacheId }))
        .catch(error => ({ success: false, cacheId, error: error.message }));
    });

    const results = await Promise.all(deletions);
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`   Ask-ai cache deletion: ${successful} ok, ${failed} failed`);

    if (failed > 0) {
      console.error(`   Failed deletions:`, results.filter(r => !r.success));
    }

    return { success: failed === 0, total: results.length, successful, failed, results };
  } catch (error) {
    console.error(`   Error deleting ask-ai cache:`, error);
    throw error;
  }
}

async function writeAskAiCache(productHandle, storeId, options, language = "en") {
  const cacheId = buildAskAiCacheKey(productHandle, storeId, language);
  const item = {
    id: cacheId,
    storeId,
    data: { userOptions: Array.isArray(options) ? options : [] },
    updatedAt: new Date().toISOString(),
  };
  try {
    await dynamodb.put({ TableName: CACHE_TABLE, Item: item }).promise();
    console.log(`   Wrote ask-ai cache: ${cacheId} (${item.data.userOptions.length} chips)`);
    return { success: true, cacheId, count: item.data.userOptions.length };
  } catch (error) {
    console.error(`   Error writing ask-ai cache:`, error);
    return { success: false, cacheId, error: error.message };
  }
}

// ─── Lambda: refresh ask-ai chips ────────────────────────────────────

async function refreshAskAiOptions(productHandle, storeId, { geminiModel = null, skipCaching = false, language = "en" } = {}) {
  // The Lambda's `language` query param defaults to "ro" if omitted and is
  // used as the suffix in its DynamoDB cache key
  // `<storeId>_userOptions_<handle>_<lang>`. Passing `language=en` makes
  // the Lambda's own cache write land at the same key our metafield
  // writer reads from. Without this, the Lambda silently caches under
  // `_ro` and our writer never finds it.
  const params = new URLSearchParams({ domain: storeId, handle: productHandle, language });
  if (skipCaching) params.set("skipCaching", "true");
  if (geminiModel) params.set("geminiModel", geminiModel);
  const url = `${ASK_AI_LAMBDA_URL}?${params.toString()}`;

  try {
    console.log(`   Refreshing ask-ai options...`);

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json().catch(() => ({}));
    const options = Array.isArray(json?.data?.userOptions)
      ? json.data.userOptions.filter(o => typeof o === "string" && o.trim().length > 0)
      : [];

    console.log(`   Ask-ai options refreshed (${duration}ms, ${options.length} chips)`);

    return { success: true, duration, url, options };
  } catch (error) {
    console.error(`   Error refreshing ask-ai options: ${error.message}`);
    return { success: false, error: error.message, url };
  }
}

// ─── Neo4j helpers ───────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function updateAskAiTimestamp(productId, storeId, optionsCount) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    const result = await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.ask_ai_options_updated_at = $updatedAt,
           p.ask_ai_options_count      = $count
       RETURN p.id as id, p.ask_ai_options_updated_at as ask_ai_options_updated_at`,
      { productId, storeId, updatedAt: now, count: neo4j.int(optionsCount || 0) }
    );

    if (result.records.length === 0) {
      console.error(`   Product not found: ${productId} in store ${storeId}`);
      return { success: false, message: "Product not found" };
    }

    console.log(`   ask_ai_options_updated_at timestamp updated in Neo4j`);
    return {
      success: true,
      productId,
      ask_ai_options_updated_at: result.records[0].get("ask_ai_options_updated_at")
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

async function getProductByHandle(handle, storeId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product {handle: $handle, storeId: $storeId})
       RETURN p.id as id, p.title as title, p.handle as handle, p.storeId as storeId`,
      { handle, storeId }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return { id: r.get("id"), title: r.get("title"), handle: r.get("handle"), storeId: r.get("storeId") };
  } catch (error) {
    console.error("Error fetching product by handle:", error);
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
      ? `AND p.ask_ai_options_updated_at IS NULL`
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
      ? `AND p.ask_ai_options_updated_at IS NULL`
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

// ─── Single product processor ────────────────────────────────────────

async function processAskAiForProduct(product, { geminiModel = null, skipCaching = false } = {}) {
  console.log(`\n   [${product.id}] ${product.title}`);
  console.log(`   Handle: ${product.handle}`);
  console.log(`   Store/Domain: ${product.storeId}`);

  try {
    const startTime = Date.now();

    await deleteAskAiCache(product.handle, product.storeId);

    const result = await refreshAskAiOptions(product.handle, product.storeId, { geminiModel, skipCaching });

    if (result.success) {
      // The Lambda also caches to the same key (we pass `language=en`),
      // but we re-`put` here as a safety net for the `--skip-caching`
      // path (where the Lambda skips its own write) and to guarantee
      // freshness for the next pipeline step.
      const cacheWrite = await writeAskAiCache(product.handle, product.storeId, result.options || []);
      if (!cacheWrite.success) {
        console.error(`   WARN — cache write failed: ${cacheWrite.error}`);
      }
      // Only stamp when the Lambda actually returned ≥1 chip. Stamping on
      // empty results pins the product to a frozen empty cache and makes
      // --missing mode skip it forever.
      const optionsCount = result.options?.length || 0;
      if (optionsCount > 0) {
        await updateAskAiTimestamp(product.id, product.storeId, optionsCount);
      } else {
        console.log(`   No options returned — skipping timestamp stamp (will retry next --missing run)`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`   Complete (${duration}ms)`);

    // Lambda failures (e.g. HTTP 502) return {success:false} — surface
    // them as errors so batch stats stay honest and the loop guard in
    // --missing mode can detect a stuck product.
    if (!result.success) {
      return { status: "error", product, duration, error: result.error || "Lambda call failed", askAi: result };
    }

    return { status: "success", product, duration, askAi: result };
  } catch (error) {
    console.error(`   Error: ${error.message}`);
    return { status: "error", product, error: error.message };
  }
}

// ─── Main batch processor ────────────────────────────────────────────

async function processAskAiRecent(storeId, options = {}) {
  const {
    batchSize = 10,
    maxProducts = null,
    startFrom = 0,
    hoursAgo = 24,
    missingOnly = false,
    reindexOnly = false,
    delayBetweenRequests = 100,
    geminiModel = null,
    skipCaching = false
  } = options;

  console.log("\n========================================");
  console.log("ASK-AI OPTIONS PROCESSOR");
  console.log("========================================");
  console.log(`Store ID: ${storeId}`);
  console.log(`Mode: ${reindexOnly ? "REINDEX (needs_reindex=true)" : missingOnly ? "MISSING ONLY" : hoursAgo ? `last ${hoursAgo} hours` : "ALL products"}`);
  console.log(`Batch size: ${batchSize} (parallel requests)`);
  console.log(`Max products: ${maxProducts || "UNLIMITED"}`);
  console.log(`Starting from: ${startFrom}`);
  console.log(`Delay between requests: ${delayBetweenRequests}ms`);
  console.log("========================================\n");

  console.log("Counting products...");
  const totalProducts = await countStoreProducts(storeId, hoursAgo, missingOnly, reindexOnly);
  console.log(`Total products to process: ${totalProducts}\n`);

  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let totalDuration = 0;
  let skip = startFrom;

  // Loop guard: in --missing mode, products that fail (Lambda HTTP error,
  // etc.) never get their timestamp stamped, so the next batch fetches
  // them again → infinite loop. Track which product ids we've seen this
  // run; if a batch returns nothing new, abort with a clear error.
  const seenProductIds = new Set();

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

      if (missingOnly) {
        const newProducts = products.filter(p => !seenProductIds.has(String(p.id)));
        if (newProducts.length === 0) {
          const stuckHandles = products.map(p => `${p.handle} (${p.id})`).join(", ");
          console.error(`\n!!! Loop guard: --missing batch returned ${products.length} product(s) we've already attempted this run.`);
          console.error(`    These products keep failing without stamping their timestamp:`);
          console.error(`    ${stuckHandles}`);
          console.error(`    Aborting to avoid infinite loop. Investigate the Lambda failure or skip these handles manually:`);
          console.error(`      MATCH (p:Product {handle: "<handle>", storeId: $s}) SET p.ask_ai_options_updated_at = datetime()`);
          break;
        }
        for (const p of products) seenProductIds.add(String(p.id));
      }

      console.log(`Fetched ${products.length} products`);
      console.log(`Processing batch with ${delayBetweenRequests}ms stagger...\n`);

      const batchPromises = [];
      for (let i = 0; i < products.length; i++) {
        const promise = processAskAiForProduct(products[i], { geminiModel, skipCaching });
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
              optionsCount: result.askAi?.options?.length || 0
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
  processAskAiRecent,
  processAskAiForProduct,
  getProductById,
  getProductByHandle,
  fetchProductsBatch,
  countStoreProducts,
  deleteAskAiCache,
  writeAskAiCache,
  refreshAskAiOptions,
  updateAskAiTimestamp
};

export default processAskAiRecent;

// ─── CLI entry point ─────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node sync-lambda-ask-ai-options.js <storeId> [options]");
  console.error("  Options:");
  console.error("    --handle <handle>    Process a single product by handle (skips batch mode)");
  console.error("    --batchSize <n>      Number of parallel requests (default: 10)");
  console.error("    --maxProducts <n>    Max products to process (default: unlimited)");
  console.error("    --startFrom <n>      Starting offset (default: 0)");
  console.error("    --hours <n>          Only products updated in last N hours (default: 24)");
  console.error("    --all                Process ALL products regardless of updated_at");
  console.error("    --missing            Only products missing ask_ai_options_updated_at");
  console.error("    --reindex            Only products flagged with needs_reindex=true");
  console.error("    --delay <ms>         Delay between requests in ms (default: 100)");
  console.error("    --skip-caching       Pass skipCaching=true to the Lambda");
  console.error("    --gemini-model <m>   Pin a specific Gemini model in the Lambda call");
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
const delayBetweenRequests = parseInt(cliOpts.delay) || 100;
const geminiModel = cliOpts["gemini-model"] || null;
const skipCaching = args.includes("--skip-caching");
const singleHandle = typeof cliOpts.handle === "string" ? cliOpts.handle : null;

(async () => {
  try {
    if (singleHandle) {
      console.log(`\n[single-handle mode] storeId=${cliStoreId} handle=${singleHandle}\n`);
      const product = await getProductByHandle(singleHandle, cliStoreId);
      if (!product) {
        console.error(`Product not found in Neo4j: handle="${singleHandle}" storeId="${cliStoreId}"`);
        process.exit(1);
      }
      const result = await processAskAiForProduct(product, { geminiModel, skipCaching });
      console.log(`\nDone. Status: ${result.status}${result.duration ? `, duration: ${result.duration}ms` : ""}${result.error ? `, error: ${result.error}` : ""}`);
      process.exit(result.status === "success" ? 0 : 1);
    }

    const result = await processAskAiRecent(cliStoreId, {
      batchSize,
      maxProducts,
      startFrom,
      hoursAgo,
      missingOnly,
      reindexOnly,
      delayBetweenRequests,
      geminiModel,
      skipCaching
    });
    console.log(`\nDone. Processed: ${result.processedCount}, Success: ${result.successCount}, Errors: ${result.errorCount}`);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
})();
