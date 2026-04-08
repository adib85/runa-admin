#!/usr/bin/env node

/**
 * Create Naomi Collections (run once per store)
 *
 * Creates automated Shopify collections for:
 *   - "Naomi's Picks — {Product Type}" per category (tag-based, self-populating)
 *   - Occasion collections for homepage (manual, refreshed by curated outfits script)
 *
 * Usage:
 *   node apps/api/src/scripts/create-naomi-collections.js <shop-domain> [access-token] [options]
 *
 * Options:
 *   --dry-run    Show what would be created without creating
 *
 * Examples:
 *   node apps/api/src/scripts/create-naomi-collections.js k8xbf0-5t.myshopify.com --dry-run
 *   node apps/api/src/scripts/create-naomi-collections.js k8xbf0-5t.myshopify.com
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

// ─── Homepage occasion collections (manual) ─────────────────────────

const OCCASION_COLLECTIONS = [
  { handle: "date-night-styled-by-naomi",     title: "Date Night Look" },
  { handle: "office-ready-styled-by-naomi",   title: "Office Ready Look" },
  { handle: "vacation-edit-styled-by-naomi",  title: "Vacation Edit Look" },
  { handle: "casual-everyday-styled-by-naomi", title: "Casual Everyday Look" },
  { handle: "evening-events-styled-by-naomi", title: "Evening & Events Look" },
];

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith("-"));

const SHOP_DOMAIN = positional[0] || "k8xbf0-5t.myshopify.com";
let ACCESS_TOKEN = positional[1] || process.env.ACCESS_TOKEN;
const dryRun = args.includes("--dry-run");

// ─── Access token ────────────────────────────────────────────────────

async function fetchAccessTokenFromDB(shopDomain) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shopDomain}`;
  const response = await fetch(url);
  const data = await response.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No accessToken found for "${shopDomain}"`);
  console.log(`  Access token fetched for ${shopDomain}`);
  return token;
}

// ─── Shopify GraphQL ─────────────────────────────────────────────────

let shopifyClient;

const COLLECTION_CREATE_MUTATION = gql`
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title handle }
      userErrors { field message }
    }
  }
`;

const GET_COLLECTIONS_QUERY = gql`
  query getCollections($first: Int!, $query: String) {
    collections(first: $first, query: $query) {
      edges {
        node { id title handle }
      }
    }
  }
`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getExistingCollections() {
  const allCollections = [];
  const queries = ["naomis-picks", "styled-by-naomi", "Naomi's Picks"];

  for (const q of queries) {
    const { collections } = await shopifyClient.request(GET_COLLECTIONS_QUERY, {
      first: 100,
      query: q,
    });
    for (const edge of collections.edges) {
      allCollections.push(edge.node);
    }
  }

  return allCollections;
}

async function createCollection(input) {
  const { collectionCreate } = await shopifyClient.request(COLLECTION_CREATE_MUTATION, { input });

  if (collectionCreate.userErrors.length > 0) {
    throw new Error(collectionCreate.userErrors.map(e => `${e.field}: ${e.message}`).join(", "));
  }

  return collectionCreate.collection;
}

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getProductTypesWithPicks() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.naomi_pick = true
         AND p.product_type IS NOT NULL AND trim(p.product_type) <> ''
       RETURN p.product_type AS productType, count(p) AS cnt
       ORDER BY cnt DESC`,
      { storeId: SHOP_DOMAIN }
    );
    return result.records.map(r => ({
      productType: r.get("productType"),
      count: r.get("cnt").toInt(),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function getVendorsWithPicks() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.naomi_pick = true
         AND p.vendor IS NOT NULL AND trim(p.vendor) <> ''
       RETURN p.vendor AS vendor, count(p) AS cnt
       ORDER BY cnt DESC`,
      { storeId: SHOP_DOMAIN }
    );
    return result.records.map(r => ({
      vendor: r.get("vendor"),
      count: r.get("cnt").toInt(),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

function toHandle(name) {
  return "naomis-picks-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
}

async function main() {
  if (!ACCESS_TOKEN) {
    ACCESS_TOKEN = await fetchAccessTokenFromDB(SHOP_DOMAIN);
  }

  shopifyClient = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2023-04/graphql.json`, {
    headers: {
      "X-Shopify-Access-Token": ACCESS_TOKEN,
      "Content-Type": "application/json"
    }
  });

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Create Naomi Collections`);
  console.log(`  Store: ${SHOP_DOMAIN}`);
  console.log(`  Mode:  ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Checking existing collections...`);
  const existing = await getExistingCollections();
  const existingHandles = new Set(existing.map(c => c.handle));
  console.log(`    Found ${existing.length} existing Naomi collections\n`);

  const stats = { created: 0, skipped: 0, errors: 0 };

  // ── Category page collections (automated, tag-based) ──

  console.log(`[2] Category page collections (automated)...\n`);
  const productTypes = await getProductTypesWithPicks();
  console.log(`    Found ${productTypes.length} product types with Naomi picks\n`);

  for (const { productType, count } of productTypes) {
    if (count < 5) {
      console.log(`    SKIP "${productType}" (only ${count} picks — need at least 5)`);
      stats.skipped++;
      continue;
    }

    const handle = toHandle(productType);
    const title = `Naomi's Picks — ${productType}`;

    if (existingHandles.has(handle)) {
      console.log(`    SKIP "${title}" (already exists)`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`    WOULD CREATE "${title}" (${count} picks) [automated]`);
      stats.created++;
      continue;
    }

    try {
      const collection = await createCollection({
        title,
        ruleSet: {
          appliedDisjunctively: false,
          rules: [
            { column: "TAG", relation: "EQUALS", condition: "naomi:pick" },
            { column: "TYPE", relation: "EQUALS", condition: productType },
          ],
        },
      });
      console.log(`    CREATED "${collection.title}" → ${collection.handle}`);
      stats.created++;
    } catch (error) {
      console.error(`    ERROR "${title}": ${error.message}`);
      stats.errors++;
    }

    await delay(500);
  }

  // ── Homepage occasion collections (manual) ──

  console.log(`\n[3] Homepage occasion collections (manual)...\n`);

  for (const occ of OCCASION_COLLECTIONS) {
    if (existingHandles.has(occ.handle)) {
      console.log(`    SKIP "${occ.title}" (already exists)`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`    WOULD CREATE "${occ.title}" [manual]`);
      stats.created++;
      continue;
    }

    try {
      const collection = await createCollection({ title: occ.title });
      console.log(`    CREATED "${collection.title}" → ${collection.handle}`);
      stats.created++;
    } catch (error) {
      console.error(`    ERROR "${occ.title}": ${error.message}`);
      stats.errors++;
    }

    await delay(500);
  }

  // ── Brand page collections (automated, tag + vendor) ──

  console.log(`\n[4] Brand page collections (automated)...\n`);
  const vendors = await getVendorsWithPicks();
  console.log(`    Found ${vendors.length} brands with Naomi picks\n`);

  for (const { vendor, count } of vendors) {
    if (count < 5) {
      stats.skipped++;
      continue;
    }

    const handle = toHandle(vendor);
    const title = `Naomi's Picks — ${vendor}`;

    if (existingHandles.has(handle)) {
      console.log(`    SKIP "${title}" (already exists)`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`    WOULD CREATE "${title}" (${count} picks) [automated]`);
      stats.created++;
      continue;
    }

    try {
      const collection = await createCollection({
        title,
        ruleSet: {
          appliedDisjunctively: false,
          rules: [
            { column: "TAG", relation: "EQUALS", condition: "naomi:pick" },
            { column: "VENDOR", relation: "EQUALS", condition: vendor },
          ],
        },
      });
      console.log(`    CREATED "${collection.title}" → ${collection.handle}`);
      stats.created++;
    } catch (error) {
      console.error(`    ERROR "${title}": ${error.message}`);
      stats.errors++;
    }

    await delay(500);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Created: ${stats.created}`);
  console.log(`    Skipped: ${stats.skipped} (already exist)`);
  console.log(`    Errors:  ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
