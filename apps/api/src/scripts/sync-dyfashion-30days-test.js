#!/usr/bin/env node

/**
 * DyFashion 30-Day Backfill Test
 * Processes products CREATED between 5 and 30 days ago that are missing
 * Complete The Look or Similar Products timestamps.
 * Skips last 5 days (already handled by daily cron).
 *
 * Usage:
 *   node apps/api/src/scripts/sync-dyfashion-30days-test.js [options]
 *
 *   Options:
 *     --batchSize <n>      Number of parallel requests (default: 40)
 *     --maxProducts <n>    Max products to process (default: unlimited)
 *     --startFrom <n>      Starting offset (default: 0)
 *     --skip-ctl           Skip Complete The Look processing
 *     --skip-similar       Skip Similar Products processing
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

const STORE_ID = "dyfashion.avanticart.ro";

const LAMBDA_URL_BASE = "https://7gduqkaho5pvkb6rfvfcfeg6ca0ymnid.lambda-url.us-east-1.on.aws/";
const SIMILAR_PRODUCTS_LAMBDA_URL = "https://ztqjtsoqzv5jgmv2v55jnrqokq0klhwg.lambda-url.us-east-1.on.aws/";

AWS.config.update({ region: AWS_REGION });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

const FROM_DAYS = 30;
const TO_DAYS = 5;

// Products published between 5–30 days ago that are missing CTL or similar timestamps
const BACKFILL_FILTER = `
  AND p.published_date IS NOT NULL
  AND datetime(p.published_date) >= datetime() - duration('P${FROM_DAYS}D')
  AND datetime(p.published_date) < datetime() - duration('P${TO_DAYS}D')
  AND (p.complete_the_look_updated_at IS NULL OR p.similar_product_updated_at IS NULL)
`;

async function countProducts(storeId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${BACKFILL_FILTER}
       RETURN count(p) as total`,
      { storeId }
    );
    return result.records[0].get("total").toInt();
  } finally {
    await session.close();
    await driver.close();
  }
}

async function fetchProductsBatch(storeId, skip, limit) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${BACKFILL_FILTER}
       RETURN p.id as id, p.title as title, p.handle as handle, p.storeId as storeId,
              p.complete_the_look_updated_at as ctlUpdatedAt,
              p.similar_product_updated_at as simUpdatedAt
       ORDER BY p.updated_at DESC
       SKIP $skip
       LIMIT $limit`,
      { storeId, skip: neo4j.int(skip), limit: neo4j.int(limit) }
    );
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      storeId: r.get("storeId"),
      ctlUpdatedAt: r.get("ctlUpdatedAt"),
      simUpdatedAt: r.get("simUpdatedAt")
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function updateTimestamp(productId, storeId, field) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.${field} = $updatedAt`,
      { productId, storeId, updatedAt: now }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Cache deletion ──────────────────────────────────────────────────

async function deleteCache(productHandle, storeId, prefix = "") {
  const languages = ["en"];
  const deletions = languages.map(lang => {
    const cacheId = prefix
      ? `${storeId.toLowerCase()}_${prefix}_${productHandle.toLowerCase()}_${lang}`
      : `${storeId}_${productHandle}_${lang}`;
    return dynamodb.delete({ TableName: CACHE_TABLE, Key: { id: cacheId } }).promise()
      .then(() => ({ success: true, cacheId }))
      .catch(err => ({ success: false, cacheId, error: err.message }));
  });
  return Promise.all(deletions);
}

// ─── Complete The Look ───────────────────────────────────────────────

function buildCtlUrl(product) {
  const params = new URLSearchParams({
    userId: "default-2",
    domain: product.storeId,
    productId: product.id,
    personality: "classic, romantic",
    chromatic: "autumn",
    isNeutral: 0,
    channelId: `runa_${product.storeId}_${crypto.randomUUID()}-outfit`,
    action: "gpt-4",
    actionId: crypto.randomUUID(),
    tokens: 1024,
    temperature: 1,
    model1: "",
    model2: "",
    skipCaching: false,
    productHandle: product.handle,
    profileId: "",
    language: "en"
  });
  return `${LAMBDA_URL_BASE}?${params.toString()}`;
}

async function processCompleteTheLook(product) {
  await deleteCache(product.handle, product.storeId);
  const url = buildCtlUrl(product);
  const start = Date.now();
  const res = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  await res.json();
  const duration = Date.now() - start;
  await updateTimestamp(product.id, product.storeId, "complete_the_look_updated_at");
  return duration;
}

// ─── Similar Products ────────────────────────────────────────────────

async function processSimilarProducts(product) {
  await deleteCache(product.handle, product.storeId, "similar_products");
  const url = `${SIMILAR_PRODUCTS_LAMBDA_URL}?domain=${product.storeId}&productHandle=${product.handle}&mode=similar`;
  const start = Date.now();
  const res = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  await res.json();
  const duration = Date.now() - start;
  await updateTimestamp(product.id, product.storeId, "similar_product_updated_at");
  return duration;
}

// ─── Single product processor ────────────────────────────────────────

async function processProduct(product, { skipCtl, skipSimilar }) {
  console.log(`\n   [${product.id}] ${product.title}`);
  console.log(`   Handle: ${product.handle}`);

  const result = { productId: product.id, title: product.title, handle: product.handle };

  const needsCtl = !skipCtl && !product.ctlUpdatedAt;
  const needsSimilar = !skipSimilar && !product.simUpdatedAt;

  if (!needsCtl && !needsSimilar) {
    console.log(`   ⏭️  Already has both timestamps, skipping`);
    return result;
  }

  if (needsCtl) {
    try {
      const d = await processCompleteTheLook(product);
      console.log(`   ✅ Complete The Look (${d}ms)`);
      result.ctlDuration = d;
      result.ctlStatus = "success";
    } catch (err) {
      console.error(`   ❌ Complete The Look error: ${err.message}`);
      result.ctlStatus = "error";
      result.ctlError = err.message;
    }
  } else if (!skipCtl) {
    console.log(`   ⏭️  Complete The Look already done`);
  }

  if (needsSimilar) {
    try {
      const d = await processSimilarProducts(product);
      console.log(`   ✅ Similar Products (${d}ms)`);
      result.similarDuration = d;
      result.similarStatus = "success";
    } catch (err) {
      console.error(`   ❌ Similar Products error: ${err.message}`);
      result.similarStatus = "error";
      result.similarError = err.message;
    }
  } else if (!skipSimilar) {
    console.log(`   ⏭️  Similar Products already done`);
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  function parseCliArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i].replace(/^--/, "");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
    return opts;
  }

  const opts = parseCliArgs(args);
  const batchSize = parseInt(opts.batchSize) || 40;
  const maxProducts = opts.maxProducts ? parseInt(opts.maxProducts) : null;
  const startFrom = parseInt(opts.startFrom) || 0;
  const skipCtl = args.includes("--skip-ctl");
  const skipSimilar = args.includes("--skip-similar");

  console.log("\n========================================");
  console.log("DYFASHION 30-DAY BACKFILL TEST");
  console.log("========================================");
  console.log(`Store: ${STORE_ID}`);
  console.log(`Published between: ${FROM_DAYS} days ago → ${TO_DAYS} days ago`);
  console.log(`(skipping last ${TO_DAYS} days — already processed by daily cron)`);
  console.log(`Filter: missing CTL or Similar Products timestamps`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Max products: ${maxProducts || "UNLIMITED"}`);
  console.log(`Starting from: ${startFrom}`);
  console.log(`Complete The Look: ${skipCtl ? "SKIPPED" : "ON"}`);
  console.log(`Similar Products: ${skipSimilar ? "SKIPPED" : "ON"}`);
  console.log("========================================\n");

  // ── Diagnostic: check what data actually exists ──
  console.log("Running diagnostics...\n");
  const driver = getDriver();
  const session = driver.session();
  try {
    const diag = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId AND p.handle IS NOT NULL AND p.handle <> ''
       RETURN
         count(p) as total,
         count(p.createdAt) as hasCreatedAt,
         count(p.updated_at) as hasUpdatedAt,
         count(p.complete_the_look_updated_at) as hasCtl,
         count(p.similar_product_updated_at) as hasSimilar,
         min(toString(p.createdAt)) as minCreatedAt,
         max(toString(p.createdAt)) as maxCreatedAt,
         min(p.updated_at) as minUpdatedAt,
         max(p.updated_at) as maxUpdatedAt`,
      { storeId: STORE_ID }
    );
    const r = diag.records[0];
    console.log(`  Total products:              ${r.get("total")}`);
    console.log(`  With createdAt:              ${r.get("hasCreatedAt")}`);
    console.log(`  With updated_at:             ${r.get("hasUpdatedAt")}`);
    console.log(`  With CTL timestamp:          ${r.get("hasCtl")}`);
    console.log(`  With Similar timestamp:      ${r.get("hasSimilar")}`);
    console.log(`  createdAt range:             ${r.get("minCreatedAt") || "N/A"} → ${r.get("maxCreatedAt") || "N/A"}`);
    console.log(`  updated_at range:            ${r.get("minUpdatedAt") || "N/A"} → ${r.get("maxUpdatedAt") || "N/A"}`);
    console.log("");

    const missingBoth = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId AND p.handle IS NOT NULL AND p.handle <> ''
         AND (p.complete_the_look_updated_at IS NULL OR p.similar_product_updated_at IS NULL)
       RETURN count(p) as total`,
      { storeId: STORE_ID }
    );
    console.log(`  Missing CTL or Similar:      ${missingBoth.records[0].get("total")}`);
    console.log("");
  } finally {
    await session.close();
    await driver.close();
  }

  console.log("Counting products (published 5–30 days ago, missing CTL/Similar)...");
  const total = await countProducts(STORE_ID);
  console.log(`Total products to process: ${total}\n`);

  if (total === 0) {
    console.log("No products found matching the filter. Check diagnostics above.");
    return;
  }

  let processed = 0, ctlSuccess = 0, ctlErrors = 0, simSuccess = 0, simErrors = 0;
  let skip = startFrom;

  while (true) {
    if (maxProducts && processed >= maxProducts) {
      console.log(`\nReached max product limit: ${maxProducts}`);
      break;
    }

    console.log(`\n--- Fetching batch (skip: ${skip}, limit: ${batchSize}) ---`);
    const products = await fetchProductsBatch(STORE_ID, skip, batchSize);

    if (products.length === 0) {
      console.log("No more products to process");
      break;
    }

    console.log(`Fetched ${products.length} products\n`);

    const batchPromises = [];
    for (let i = 0; i < products.length; i++) {
      batchPromises.push(processProduct(products[i], { skipCtl, skipSimilar }));
      if (i < products.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const results = await Promise.allSettled(batchPromises);

    results.forEach(r => {
      processed++;
      if (r.status === "fulfilled") {
        const v = r.value;
        if (v.ctlStatus === "success") ctlSuccess++;
        if (v.ctlStatus === "error") ctlErrors++;
        if (v.similarStatus === "success") simSuccess++;
        if (v.similarStatus === "error") simErrors++;
      }
    });

    console.log(`\nBatch done — CTL: ${ctlSuccess} ok / ${ctlErrors} err | Similar: ${simSuccess} ok / ${simErrors} err`);
    skip += batchSize;
  }

  console.log("\n========================================");
  console.log("BACKFILL COMPLETE");
  console.log("========================================");
  console.log(`Total processed: ${processed}`);
  if (!skipCtl) console.log(`Complete The Look: ${ctlSuccess} success, ${ctlErrors} errors`);
  if (!skipSimilar) console.log(`Similar Products: ${simSuccess} success, ${simErrors} errors`);
  console.log("========================================\n");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
