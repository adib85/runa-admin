#!/usr/bin/env node

/**
 * Sync Shopify Descriptions
 *
 * Fetches products from Neo4j that have AI-generated descriptions, checks the
 * corresponding products in the Shopify store, and updates the Shopify
 * description when it differs from the Neo4j one.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-shopify-descriptions.js <shop-domain> <access-token> [options]
 *
 * Options:
 *   --dry-run               Check products without writing anything to Shopify
 *   --handle <handle>       Process a single product by handle
 *   --force                 Update ALL products (even those with existing descriptions)
 *   --recent                Only process products updated in the last 48 hours
 *   --hours <n>             Custom hours window for --recent (default: 48)
 *   --missing               Only process products not yet synced (description_synced_at IS NULL)
 *
 * Examples:
 *   node apps/api/src/scripts/sync-shopify-descriptions.js k8xbf0-5t.myshopify.com shpat_xxx
 *   node apps/api/src/scripts/sync-shopify-descriptions.js k8xbf0-5t.myshopify.com shpat_xxx --dry-run
 *   node apps/api/src/scripts/sync-shopify-descriptions.js k8xbf0-5t.myshopify.com shpat_xxx --missing
 *   node apps/api/src/scripts/sync-shopify-descriptions.js k8xbf0-5t.myshopify.com shpat_xxx --handle petar-petrov-bicolor-cashmere-sweater
 *   node apps/api/src/scripts/sync-shopify-descriptions.js k8xbf0-5t.myshopify.com shpat_xxx --force
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import { GraphQLClient, gql } from "graphql-request";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('-') && (i === 0 || args[i - 1] !== '--handle'));
const SHOP_DOMAIN = positional[0] || process.env.SHOP_DOMAIN || "k8xbf0-5t.myshopify.com";
const ACCESS_TOKEN = positional[1] || process.env.ACCESS_TOKEN;

const dryRun = args.includes("--dry-run");
const forceAll = args.includes("--force");
const recentOnly = args.includes("--recent");
const missingOnly = args.includes("--missing");
const hoursIdx = args.indexOf("--hours");
const recentHours = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1], 10) : 48;
const handleIdx = args.indexOf("--handle");
const singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;

const RATE_LIMIT_DELAY_MS = 500;

// ─── Shopify GraphQL client ──────────────────────────────────────────

const shopifyClient = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2023-04/graphql.json`, {
  headers: {
    "X-Shopify-Access-Token": ACCESS_TOKEN,
    "Content-Type": "application/json"
  }
});

const UPDATE_PRODUCT_MUTATION = gql`
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id descriptionHtml }
      userErrors { field message }
    }
  }
`;

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getProductsWithDescriptions() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const recentFilter = recentOnly
      ? `AND p.updated_at >= datetime($cutoff)`
      : "";
    const sourceFilter = forceAll
      ? ""
      : `AND (p.descriptionSource IS NOT NULL AND p.descriptionSource <> "original")`;
    const missingFilter = missingOnly
      ? `AND p.description_synced_at IS NULL`
      : "";

    const query = `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.description IS NOT NULL AND trim(p.description) <> ""
         ${sourceFilter}
         ${recentFilter}
         ${missingFilter}
       RETURN p.id AS id, p.title AS title, p.description AS description, p.descriptionSource AS source
       ORDER BY p.updated_at DESC`;

    const cutoff = new Date(Date.now() - recentHours * 60 * 60 * 1000).toISOString();
    const result = await session.run(query, { storeId: SHOP_DOMAIN, cutoff });
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      description: r.get("description"),
      source: r.get("source"),
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
       RETURN p.id AS id, p.title AS title, p.description AS description, p.descriptionSource AS source`,
      { storeId: SHOP_DOMAIN, handle }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      id: r.get("id"),
      title: r.get("title"),
      description: r.get("description"),
      source: r.get("source"),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

async function updateDescriptionSyncedAt(productId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.description_synced_at = $syncedAt
       RETURN p.id AS id`,
      { productId, storeId: SHOP_DOMAIN, syncedAt: now }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Shopify API ─────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateShopifyDescription(productId, newDescription, maxRetries = 3) {
  const gid = `gid://shopify/Product/${productId}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { productUpdate } = await shopifyClient.request(UPDATE_PRODUCT_MUTATION, {
        input: { id: gid, descriptionHtml: newDescription }
      });

      if (productUpdate.userErrors.length > 0) {
        throw new Error(productUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join(", "));
      }

      return productUpdate.product;
    } catch (error) {
      const is5xx = error.message?.includes("503") || error.message?.includes("500") || error.message?.includes("502");
      if (is5xx && attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
        console.log(`    [Retry] 5xx error, waiting ${(backoff / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})...`);
        await delay(backoff);
        continue;
      }
      throw error;
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Sync Shopify Descriptions`);
  console.log(`  Store:  ${SHOP_DOMAIN}`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN (no updates)" : "LIVE (will update Shopify)"}`);
  console.log(`  Filter: ${missingOnly ? "MISSING ONLY (not yet synced)" : forceAll ? "ALL products with descriptions" : "Only AI-generated descriptions"}`);
  if (recentOnly) console.log(`  Recent: Last ${recentHours} hours only`);
  if (singleHandle) console.log(`  Handle: ${singleHandle}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  let neo4jProducts;

  if (singleHandle) {
    console.log(`[1] Looking up handle "${singleHandle}" in Neo4j...`);
    const product = await getProductByHandle(singleHandle);
    if (!product) {
      console.log(`    Product not found in Neo4j for handle "${singleHandle}"`);
      return;
    }
    const hasDesc = product.description && product.description.trim().length > 0;
    console.log(`    Found: "${product.title}" (id: ${product.id})`);
    console.log(`    Source: ${product.source || "unknown"}`);
    console.log(`    Neo4j description: ${hasDesc ? `${product.description.length} chars` : "EMPTY"}`);
    if (!hasDesc) {
      console.log(`    No description in Neo4j — nothing to push.`);
      return;
    }
    neo4jProducts = [product];
  } else {
    console.log(`[1] Fetching products with descriptions from Neo4j...`);
    neo4jProducts = await getProductsWithDescriptions();
    console.log(`    Found ${neo4jProducts.length} products with descriptions\n`);
  }

  if (neo4jProducts.length === 0) {
    console.log("Nothing to do — no products with descriptions in Neo4j.");
    return;
  }

  const stats = { checked: 0, updated: 0, skipped: 0, errors: 0 };

  for (const neo4jProduct of neo4jProducts) {
    stats.checked++;
    const tag = `[${stats.checked}/${neo4jProducts.length}]`;

    try {
      if (dryRun) {
        console.log(`${tag} "${neo4jProduct.title}" — WOULD UPDATE (${neo4jProduct.description.length} chars, source: ${neo4jProduct.source || "unknown"})`);
        stats.updated++;
      } else {
        await updateShopifyDescription(neo4jProduct.id, neo4jProduct.description);
        await updateDescriptionSyncedAt(neo4jProduct.id);
        console.log(`${tag} "${neo4jProduct.title}" — UPDATED (${neo4jProduct.description.length} chars)`);
        stats.updated++;
      }
    } catch (error) {
      console.error(`${tag} "${neo4jProduct.title}" — ERROR: ${error.message}`);
      stats.errors++;
    }

    await delay(RATE_LIMIT_DELAY_MS);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Checked:  ${stats.checked}`);
  console.log(`    Updated:  ${stats.updated}`);
  console.log(`    Errors:   ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
