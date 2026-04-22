#!/usr/bin/env node

/**
 * Sync Toff SEO (Title + MetaTagDescription)
 *
 * Fetches products from Neo4j that have AI-generated SEO data (seoTitle and
 * seoMetaDescription), then updates the corresponding products in the VTEX
 * (toff) catalog by writing into the VTEX `Title` and `MetaTagDescription`
 * fields.
 *
 * By default, products that ALREADY have a non-empty Title in VTEX are skipped
 * to avoid clobbering manually-curated SEO. Use --overwrite to force update.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-toff-seo.js [--dry-run] [--overwrite]
 *   node apps/api/src/scripts/sync-toff-seo.js --handle <handle-or-url> [--dry-run] [--overwrite]
 *
 * Options:
 *   --dry-run                Check products without writing anything to VTEX
 *   --overwrite              Update VTEX even if Title/MetaTagDescription already exist
 *   --handle <handle-or-url> Process a single product by handle or toff.ro URL
 *
 * Examples:
 *   node apps/api/src/scripts/sync-toff-seo.js --dry-run
 *   node apps/api/src/scripts/sync-toff-seo.js
 *   node apps/api/src/scripts/sync-toff-seo.js --overwrite
 *   node apps/api/src/scripts/sync-toff-seo.js --handle philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

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
const overwrite = args.includes("--overwrite");
const handleIdx = args.indexOf("--handle");
let singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;
if (singleHandle) {
  const urlMatch = singleHandle.match(/toff\.ro\/([^/]+)\/p/);
  if (urlMatch) singleHandle = urlMatch[1];
}

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

async function getProductsWithSEO() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.seoTitle IS NOT NULL AND trim(p.seoTitle) <> ""
         AND p.seoMetaDescription IS NOT NULL AND trim(p.seoMetaDescription) <> ""
       RETURN p.id AS id, p.title AS title,
              p.seoTitle AS seoTitle, p.seoMetaDescription AS seoMetaDescription
       ORDER BY p.title`,
      { storeId: STORE_ID }
    );
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      seoTitle: r.get("seoTitle"),
      seoMetaDescription: r.get("seoMetaDescription"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function getProductByHandle(handle) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId AND p.handle = $handle
       RETURN p.id AS id, p.title AS title,
              p.seoTitle AS seoTitle, p.seoMetaDescription AS seoMetaDescription`,
      { storeId: STORE_ID, handle }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      id: r.get("id"),
      title: r.get("title"),
      seoTitle: r.get("seoTitle"),
      seoMetaDescription: r.get("seoMetaDescription"),
    };
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

async function updateVtexSEO(productId, vtexProduct, seoTitle, seoMetaDescription) {
  // VTEX requires ALL fields on PUT — omitted fields get deleted
  return vtexRequest(`/api/catalog/pvt/product/${productId}`, {
    method: "PUT",
    body: { ...vtexProduct, Title: seoTitle, MetaTagDescription: seoMetaDescription },
  });
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Sync Toff SEO (Title + MetaTagDescription)`);
  console.log(`  Store:     ${STORE_ID}`);
  console.log(`  Mode:      ${dryRun ? "DRY RUN (no updates)" : "LIVE (will update VTEX)"}`);
  console.log(`  Overwrite: ${overwrite ? "YES (will overwrite existing SEO)" : "NO (skip products with existing Title)"}`);
  if (singleHandle) console.log(`  Handle:    ${singleHandle}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  let neo4jProducts;

  if (singleHandle) {
    console.log(`[1] Looking up handle "${singleHandle}" in Neo4j...`);
    const product = await getProductByHandle(singleHandle);
    if (!product) {
      console.log(`    Product not found in Neo4j for handle "${singleHandle}"`);
      return;
    }
    const hasSEO = product.seoTitle && product.seoTitle.trim().length > 0;
    console.log(`    Found: "${product.title}" (id: ${product.id})`);
    console.log(`    Neo4j seoTitle:           ${hasSEO ? `"${product.seoTitle}" (${product.seoTitle.length} chars)` : "EMPTY"}`);
    console.log(`    Neo4j seoMetaDescription: ${product.seoMetaDescription ? `"${product.seoMetaDescription.substring(0, 80)}..." (${product.seoMetaDescription.length} chars)` : "EMPTY"}`);
    if (!hasSEO) {
      console.log(`    No SEO data in Neo4j — nothing to push.`);
      return;
    }
    neo4jProducts = [product];
  } else {
    console.log(`[1] Fetching products with SEO data from Neo4j...`);
    neo4jProducts = await getProductsWithSEO();
    console.log(`    Found ${neo4jProducts.length} products with SEO data\n`);
  }

  if (neo4jProducts.length === 0) {
    console.log("Nothing to do — no products with SEO data in Neo4j.");
    return;
  }

  const stats = { checked: 0, updated: 0, skipped: 0, notFound: 0, errors: 0 };

  for (const neo4jProduct of neo4jProducts) {
    stats.checked++;
    const tag = `[${stats.checked}/${neo4jProducts.length}]`;

    try {
      const vtexProduct = await getVtexProduct(neo4jProduct.id);
      const vtexTitle = (vtexProduct.Title || "").trim();
      const vtexMeta = (vtexProduct.MetaTagDescription || "").trim();
      const hasExistingSEO = vtexTitle.length > 0 || vtexMeta.length > 0;

      if (hasExistingSEO && !overwrite) {
        console.log(`${tag} "${neo4jProduct.title}" — already has SEO (Title: ${vtexTitle.length}ch, Meta: ${vtexMeta.length}ch), skipping (use --overwrite to force)`);
        stats.skipped++;
      } else if (dryRun) {
        const verb = hasExistingSEO ? "WOULD OVERWRITE" : "WOULD UPDATE";
        console.log(`${tag} "${neo4jProduct.title}" — ${verb}`);
        console.log(`    new Title: "${neo4jProduct.seoTitle}" (${neo4jProduct.seoTitle.length}ch)`);
        console.log(`    new Meta:  "${neo4jProduct.seoMetaDescription.substring(0, 100)}..." (${neo4jProduct.seoMetaDescription.length}ch)`);
        stats.updated++;
      } else {
        await updateVtexSEO(
          neo4jProduct.id,
          vtexProduct,
          neo4jProduct.seoTitle,
          neo4jProduct.seoMetaDescription
        );
        const verb = hasExistingSEO ? "OVERWROTE" : "UPDATED";
        console.log(`${tag} "${neo4jProduct.title}" — ${verb} (Title: ${neo4jProduct.seoTitle.length}ch, Meta: ${neo4jProduct.seoMetaDescription.length}ch)`);
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

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Checked:                 ${stats.checked}`);
  console.log(`    Updated:                 ${stats.updated}`);
  console.log(`    Skipped (had SEO):       ${stats.skipped}`);
  console.log(`    Not found in VTEX:       ${stats.notFound}`);
  console.log(`    Errors:                  ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
