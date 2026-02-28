#!/usr/bin/env node

/**
 * Backfill SKUs for Toff products
 *
 * Gets all Toff products from Neo4j, fetches each product's productReference
 * from VTEX, and updates the sku field on the Product node in Neo4j.
 *
 * Processes in batches of 30 to avoid overwhelming VTEX.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-toff-skus.js
 *   node apps/api/src/scripts/backfill-toff-skus.js --dry-run
 */

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;

const STORE_ID = `${accountName}.vtexcommercestable.com.br`;
const BASE_URL = `https://${accountName}.vtexcommercestable.com.br`;
const VTEX_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
};

const BATCH_SIZE = 30;
const RATE_LIMIT_MS = 500;
const MAX_RETRIES = 5;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getAllToffProducts() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product) WHERE p.storeId = $storeId
       RETURN p.id AS id, p.title AS title, p.sku AS sku
       ORDER BY p.title`,
      { storeId: STORE_ID }
    );
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      sku: r.get("sku"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function updateSkuBatch(updates) {
  const driver = getDriver();
  const session = driver.session();
  try {
    await session.run(
      `UNWIND $updates AS u
       MATCH (p:Product {id: u.id})
       SET p.sku = u.sku, p.updated_at = $now`,
      { updates, now: new Date().toISOString() }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

async function vtexGetProduct(productId) {
  const url = `${BASE_URL}/api/catalog/pvt/product/${productId}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: VTEX_HEADERS });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 60000);
        console.log(`  [VTEX] 429, waiting ${(backoff / 1000).toFixed(1)}s...`);
        await delay(backoff);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} - ${text}`);
      }
      return res.json();
    } catch (error) {
      if ((error.code === "ECONNRESET" || error.code === "ETIMEDOUT") && attempt < MAX_RETRIES) {
        await delay(Math.min(2000 * Math.pow(2, attempt), 30000));
        continue;
      }
      throw error;
    }
  }
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Backfill Toff SKUs`);
  console.log(`  Store: ${STORE_ID}`);
  console.log(`  Mode:  ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Fetching all Toff products from Neo4j...`);
  const products = await getAllToffProducts();
  console.log(`    Total products: ${products.length}`);

  const needsSku = products.filter(p => !p.sku);
  const alreadyHasSku = products.length - needsSku.length;
  console.log(`    Already have SKU: ${alreadyHasSku}`);
  console.log(`    Need SKU: ${needsSku.length}\n`);

  if (needsSku.length === 0) {
    console.log("Nothing to do — all products already have a SKU.");
    return;
  }

  const stats = { fetched: 0, updated: 0, noRef: 0, notFound: 0, errors: 0 };
  const totalBatches = Math.ceil(needsSku.length / BATCH_SIZE);

  for (let i = 0; i < needsSku.length; i += BATCH_SIZE) {
    const batch = needsSku.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n── Batch ${batchNum}/${totalBatches} (${batch.length} products) ──\n`);

    const updates = [];

    for (const product of batch) {
      stats.fetched++;
      const tag = `[${stats.fetched}/${needsSku.length}]`;

      try {
        const vtexProduct = await vtexGetProduct(product.id);
        const ref = (vtexProduct.RefId || vtexProduct.ProductRefId || "").trim();

        if (ref) {
          console.log(`${tag} "${product.title}" → SKU: ${ref}`);
          updates.push({ id: product.id, sku: ref });
          stats.updated++;
        } else {
          console.log(`${tag} "${product.title}" → no productReference in VTEX`);
          stats.noRef++;
        }
      } catch (error) {
        if (error.message.includes("404")) {
          console.log(`${tag} "${product.title}" (id: ${product.id}) → not found in VTEX`);
          stats.notFound++;
        } else {
          console.error(`${tag} "${product.title}" → ERROR: ${error.message}`);
          stats.errors++;
        }
      }

      await delay(RATE_LIMIT_MS);
    }

    if (updates.length > 0 && !dryRun) {
      await updateSkuBatch(updates);
      console.log(`\n  [Neo4j] ✓ Saved ${updates.length} SKUs`);
    } else if (updates.length > 0) {
      console.log(`\n  [DRY RUN] Would save ${updates.length} SKUs`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Fetched from VTEX:    ${stats.fetched}`);
  console.log(`    SKUs saved:           ${stats.updated}`);
  console.log(`    No reference in VTEX: ${stats.noRef}`);
  console.log(`    Not found in VTEX:    ${stats.notFound}`);
  console.log(`    Errors:               ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
