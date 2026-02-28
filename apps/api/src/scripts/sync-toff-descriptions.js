#!/usr/bin/env node

/**
 * Sync Toff Descriptions
 *
 * Fetches products from Neo4j that have descriptions, checks the corresponding
 * products in the VTEX (toff) catalog, and updates the VTEX description when
 * the VTEX product has no description.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-toff-descriptions.js [--dry-run]
 *
 * Options:
 *   --dry-run   Check products without writing anything to VTEX
 *
 * Examples:
 *   node apps/api/src/scripts/sync-toff-descriptions.js
 *   node apps/api/src/scripts/sync-toff-descriptions.js --dry-run
 */

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

// ─── Toff defaults ───────────────────────────────────────────────────

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const STORE_ID = `${accountName}.vtexcommercestable.com.br`;
const BASE_URL = `https://${accountName}.vtexcommercestable.com.br`;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
};

const RATE_LIMIT_DELAY_MS = 500;
const MAX_RETRIES = 5;

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getProductsWithDescriptions() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE p.description IS NOT NULL AND trim(p.description) <> ""
       RETURN p.id AS id, p.title AS title, p.description AS description
       ORDER BY p.title`,
      { storeId: STORE_ID }
    );
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      description: r.get("description"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── VTEX API ────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function vtexRequest(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: options.method || "GET",
        headers: HEADERS,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 60000);
        if (attempt < MAX_RETRIES) {
          console.log(`  [VTEX] 429 rate-limited, waiting ${(backoff / 1000).toFixed(1)}s (retry ${attempt + 1}/${MAX_RETRIES})...`);
          await delay(backoff);
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} - ${text}`);
      }

      return res.json();
    } catch (error) {
      if ((error.code === "ECONNRESET" || error.code === "ETIMEDOUT") && attempt < MAX_RETRIES) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
        console.log(`  [VTEX] ${error.code}, retrying in ${(backoff / 1000).toFixed(1)}s...`);
        await delay(backoff);
        continue;
      }
      throw error;
    }
  }
}

async function getVtexProduct(productId) {
  return vtexRequest(`/api/catalog/pvt/product/${productId}`);
}

async function updateVtexDescription(productId, vtexProduct, newDescription) {
  // VTEX requires ALL fields on PUT — omitted fields get deleted
  return vtexRequest(`/api/catalog/pvt/product/${productId}`, {
    method: "PUT",
    body: { ...vtexProduct, Description: newDescription },
  });
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Sync Toff Descriptions`);
  console.log(`  Store:  ${STORE_ID}`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN (no updates)" : "LIVE (will update VTEX)"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // 1. Get products from Neo4j that have descriptions
  console.log(`[1] Fetching products with descriptions from Neo4j...`);
  const neo4jProducts = await getProductsWithDescriptions();
  console.log(`    Found ${neo4jProducts.length} products with descriptions\n`);

  if (neo4jProducts.length === 0) {
    console.log("Nothing to do — no products with descriptions in Neo4j.");
    return;
  }

  // 2. For each product, check VTEX and update if needed
  const stats = { checked: 0, updated: 0, skipped: 0, notFound: 0, errors: 0 };

  for (const neo4jProduct of neo4jProducts) {
    stats.checked++;
    const tag = `[${stats.checked}/${neo4jProducts.length}]`;

    try {
      const vtexProduct = await getVtexProduct(neo4jProduct.id);
      const vtexDesc = (vtexProduct.Description || "").trim();

      if (vtexDesc.length > 0) {
        console.log(`${tag} "${neo4jProduct.title}" — already has description (${vtexDesc.length} chars), skipping`);
        stats.skipped++;
      } else if (dryRun) {
        console.log(`${tag} "${neo4jProduct.title}" — WOULD UPDATE (${neo4jProduct.description.length} chars from Neo4j)`);
        stats.updated++;
      } else {
        await updateVtexDescription(neo4jProduct.id, vtexProduct, neo4jProduct.description);
        console.log(`${tag} "${neo4jProduct.title}" — UPDATED (${neo4jProduct.description.length} chars)`);
        stats.updated++;
      }
    } catch (error) {
      if (error.message.includes("404")) {
        console.log(`${tag} "${neo4jProduct.title}" (id: ${neo4jProduct.id}) — not found in VTEX`);
        stats.notFound++;
      } else {
        console.error(`${tag} "${neo4jProduct.title}" — ERROR: ${error.message}`);
        stats.errors++;
      }
    }

    await delay(RATE_LIMIT_DELAY_MS);
  }

  // 3. Summary
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Checked:                ${stats.checked}`);
  console.log(`    Updated:                ${stats.updated}`);
  console.log(`    Already had description: ${stats.skipped}`);
  console.log(`    Not found in VTEX:      ${stats.notFound}`);
  console.log(`    Errors:                 ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
