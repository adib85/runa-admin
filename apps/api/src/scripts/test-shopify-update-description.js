#!/usr/bin/env node

/**
 * Sync Shopify Descriptions
 *
 * Fetches products from Neo4j that have AI-generated descriptions, checks the
 * corresponding products in the Shopify store, and updates the Shopify
 * description when it differs from the Neo4j one.
 *
 * Usage:
 *   node apps/api/src/scripts/test-shopify-update-description.js [shop-domain] [access-token] [options]
 *
 * Options:
 *   --dry-run               Check products without writing anything to Shopify
 *   --handle <handle>       Process a single product by handle
 *   --force                 Update ALL products (even those with existing descriptions)
 *
 * Examples:
 *   node apps/api/src/scripts/test-shopify-update-description.js
 *   node apps/api/src/scripts/test-shopify-update-description.js --dry-run
 *   node apps/api/src/scripts/test-shopify-update-description.js --handle petar-petrov-bicolor-cashmere-sweater
 *   node apps/api/src/scripts/test-shopify-update-description.js --force
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
const handleIdx = args.indexOf("--handle");
const singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;

const RATE_LIMIT_DELAY_MS = 300;

// ─── Shopify GraphQL client ──────────────────────────────────────────

const shopifyClient = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
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
    const query = forceAll
      ? `MATCH (p:Product)
         WHERE p.storeId = $storeId
           AND p.description IS NOT NULL AND trim(p.description) <> ""
         RETURN p.id AS id, p.title AS title, p.description AS description, p.descriptionSource AS source
         ORDER BY p.title`
      : `MATCH (p:Product)
         WHERE p.storeId = $storeId
           AND p.description IS NOT NULL AND trim(p.description) <> ""
           AND (p.descriptionSource IS NOT NULL AND p.descriptionSource <> "original")
         RETURN p.id AS id, p.title AS title, p.description AS description, p.descriptionSource AS source
         ORDER BY p.title`;

    const result = await session.run(query, { storeId: SHOP_DOMAIN });
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

// ─── Shopify API ─────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateShopifyDescription(productId, newDescription) {
  const gid = `gid://shopify/Product/${productId}`;
  const { productUpdate } = await shopifyClient.request(UPDATE_PRODUCT_MUTATION, {
    input: { id: gid, descriptionHtml: newDescription }
  });

  if (productUpdate.userErrors.length > 0) {
    throw new Error(productUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join(", "));
  }

  return productUpdate.product;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Sync Shopify Descriptions`);
  console.log(`  Store:  ${SHOP_DOMAIN}`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN (no updates)" : "LIVE (will update Shopify)"}`);
  console.log(`  Filter: ${forceAll ? "ALL products with descriptions" : "Only AI-generated descriptions"}`);
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
