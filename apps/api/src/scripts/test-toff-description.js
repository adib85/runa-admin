#!/usr/bin/env node

/**
 * Test Toff Description — single product
 *
 * Looks up a product by its handle (or URL) in Neo4j, checks the VTEX catalog,
 * and updates the VTEX description if it's missing.
 *
 * Usage:
 *   node apps/api/src/scripts/test-toff-description.js <handle-or-url> [--dry-run]
 *
 * Examples:
 *   node apps/api/src/scripts/test-toff-description.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
 *   node apps/api/src/scripts/test-toff-description.js https://www.toff.ro/philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202/p
 *   node apps/api/src/scripts/test-toff-description.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202 --dry-run
 */

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

// ─── Toff defaults ───────────────────────────────────────────────────

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;

// ─── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filteredArgs = args.filter(a => !a.startsWith("-"));

let handleInput = filteredArgs[0];

if (!handleInput) {
  console.error(`
Usage: node test-toff-description.js <handle-or-url> [--dry-run]

  handle-or-url   Product handle or full toff.ro URL
  --dry-run       Check only, don't update VTEX

Examples:
  node test-toff-description.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
  node test-toff-description.js https://www.toff.ro/philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202/p
  `);
  process.exit(1);
}

// Extract handle from URL if needed: https://www.toff.ro/<handle>/p
const urlMatch = handleInput.match(/toff\.ro\/([^/]+)\/p/);
const handle = urlMatch ? urlMatch[1] : handleInput;

const STORE_ID = `${accountName}.vtexcommercestable.com.br`;
const BASE_URL = `https://${accountName}.vtexcommercestable.com.br`;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
};
const MAX_RETRIES = 5;

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function findProductByHandle(handle) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE p.handle = $handle
       RETURN p.id AS id, p.title AS title, p.description AS description, p.handle AS handle`,
      { storeId: STORE_ID, handle }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      id: r.get("id"),
      title: r.get("title"),
      description: r.get("description"),
      handle: r.get("handle"),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── VTEX ────────────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Test Toff Description — single product`);
  console.log(`  Store:  ${STORE_ID}`);
  console.log(`  Handle: ${handle}`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // 1. Find in Neo4j
  console.log(`[1] Looking up handle "${handle}" in Neo4j...`);
  const neo4jProduct = await findProductByHandle(handle);

  if (!neo4jProduct) {
    console.log(`    Product not found in Neo4j for store ${STORE_ID}`);
    return;
  }

  const hasNeo4jDesc = neo4jProduct.description && neo4jProduct.description.trim().length > 0;
  console.log(`    Found: "${neo4jProduct.title}" (id: ${neo4jProduct.id})`);
  console.log(`    Neo4j description: ${hasNeo4jDesc ? `${neo4jProduct.description.length} chars` : "EMPTY"}`);
  if (hasNeo4jDesc) {
    console.log(`    Preview: ${neo4jProduct.description.substring(0, 150)}...`);
  }

  // 2. Fetch from VTEX
  console.log(`\n[2] Fetching product ${neo4jProduct.id} from VTEX Catalog API...`);
  const vtexProduct = await vtexRequest(`/api/catalog/pvt/product/${neo4jProduct.id}`);
  const vtexDesc = (vtexProduct.Description || "").trim();

  console.log(`    VTEX Name: ${vtexProduct.Name}`);
  console.log(`    VTEX BrandId: ${vtexProduct.BrandId}`);
  console.log(`    VTEX CategoryId: ${vtexProduct.CategoryId}`);
  console.log(`    VTEX Description: ${vtexDesc.length > 0 ? `${vtexDesc.length} chars` : "EMPTY"}`);
  if (vtexDesc.length > 0) {
    console.log(`    Preview: ${vtexDesc.substring(0, 150)}...`);
  }

  // 3. Decide
  if (vtexDesc.length > 0) {
    console.log(`\n[3] VTEX already has a description — nothing to do.`);
    return;
  }

  if (!hasNeo4jDesc) {
    console.log(`\n[3] Neo4j has no description either — nothing to push.`);
    return;
  }

  // 4. Update
  if (dryRun) {
    console.log(`\n[3] DRY RUN — would update VTEX with Neo4j description (${neo4jProduct.description.length} chars)`);
  } else {
    console.log(`\n[3] Updating VTEX description...`);
    const updated = await vtexRequest(`/api/catalog/pvt/product/${neo4jProduct.id}`, {
      method: "PUT",
      body: { ...vtexProduct, Description: neo4jProduct.description },
    });
    console.log(`    Done! Updated description: ${(updated.Description || "").length} chars`);
  }

  // 5. Verify
  if (!dryRun) {
    console.log(`\n[4] Verifying — re-fetching from VTEX...`);
    await delay(2000);
    const verified = await vtexRequest(`/api/catalog/pvt/product/${neo4jProduct.id}`);
    const verifiedDesc = (verified.Description || "").trim();
    console.log(`    Description length: ${verifiedDesc.length} chars`);
    console.log(`    Match: ${verifiedDesc === neo4jProduct.description ? "YES" : "NO"}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
