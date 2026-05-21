#!/usr/bin/env node

/**
 * Bronze Snake — re-index a small set of products by collection handle.
 *
 * Pulls only products that belong to the listed Shopify collections
 * (default: `womens-jackets-coats` and `womens-bags-and-shoes`),
 * runs them through the full sync pipeline (AI properties, embeddings,
 * demographic detection, style-filter category enrichment), and writes
 * to Neo4j / DynamoDB / PubNub.
 *
 * Use this after changing the Bronze Snake-specific transform logic so you
 * don't have to wait ~17 minutes for a full --force resync of all 3,377
 * products.
 *
 * Usage:
 *   node apps/api/src/scripts/reindex-bronzesnake-collections.js
 *   node apps/api/src/scripts/reindex-bronzesnake-collections.js --collections womens-jackets-coats,womens-bags-and-shoes
 *   node apps/api/src/scripts/reindex-bronzesnake-collections.js --dry-run
 *   node apps/api/src/scripts/reindex-bronzesnake-collections.js --max 5
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { gql } from "graphql-request";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { ShopifyProvider } from "../sync/providers/shopify.js";

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const DEFAULT_COLLECTIONS = ["womens-jackets-coats", "womens-bags-and-shoes", "womens-swim"];

const args = process.argv.slice(2);
const tokenIdx = args.indexOf("--token");
const collIdx = args.indexOf("--collections");
const maxIdx = args.indexOf("--max");
const DRY_RUN = args.includes("--dry-run");
const COLLECTIONS = collIdx !== -1 ? args[collIdx + 1].split(",").map(s => s.trim()) : DEFAULT_COLLECTIONS;
const MAX = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : null;

async function fetchAccessToken() {
  if (args[tokenIdx + 1] && tokenIdx !== -1) return args[tokenIdx + 1];
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const j = await r.json();
  const t = j?.data?.accessToken;
  if (!t) throw new Error(`No accessToken found in Lambda DB for ${SHOP}`);
  return t;
}

async function lookupCollectionIds(provider, handles) {
  const ids = [];
  for (const handle of handles) {
    const r = await provider.graphQLClient.request(gql`
      query ($handle: String!) {
        collectionByHandle(handle: $handle) { id title productsCount { count } }
      }
    `, { handle });
    if (!r.collectionByHandle) {
      throw new Error(`Collection not found: ${handle}`);
    }
    const numericId = r.collectionByHandle.id.replace("gid://shopify/Collection/", "");
    ids.push({
      handle,
      id: numericId,
      title: r.collectionByHandle.title,
      count: r.collectionByHandle.productsCount?.count || 0,
    });
  }
  return ids;
}

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Bronze Snake — collection re-index`);
  console.log(`  Shop:        ${SHOP}`);
  console.log(`  Collections: ${COLLECTIONS.join(", ")}`);
  console.log(`  Mode:        ${DRY_RUN ? "DRY-RUN" : "LIVE (writes to Neo4j/DynamoDB/PubNub)"}`);
  console.log(`  Max:         ${MAX ?? "no limit"}`);
  console.log(`══════════════════════════════════════════════════════════\n`);

  const accessToken = await fetchAccessToken();

  const provider = new ShopifyProvider({
    shopName: SHOP,
    accessToken,
    region: "us-east-1",
    forceAll: true,        // skip "already in Neo4j" filter so each product is re-processed
    dryRun: DRY_RUN,
    maxProducts: MAX,
    demographic: "woman",
  });

  // Resolve collection IDs and build the GraphQL filter
  const colls = await lookupCollectionIds(provider, COLLECTIONS);
  console.log("Resolved collections:");
  colls.forEach(c => console.log(`  - ${c.handle.padEnd(28)} id=${c.id.padEnd(15)} ${c.title}  (${c.count} products in Shopify)`));

  const idFilter = colls.map(c => `collection_id:${c.id}`).join(" OR ");
  provider.productQueryFilter = `(${idFilter}) AND status:active AND published_status:published`;
  console.log(`\nGraphQL filter:\n  ${provider.productQueryFilter}\n`);

  // Run the full sync pipeline (the provider was constructed with forceAll: true
  // and dryRun matching the flag, so behavior matches sync-modular.js exactly).
  await provider.sync();

  console.log(`\n  ✓ Done. Re-indexed products from ${COLLECTIONS.length} collection(s).\n`);
  process.exit(0);
}

main().catch(e => {
  console.error("\nError:", e.message);
  console.error(e.stack);
  process.exit(1);
});
