#!/usr/bin/env node

/**
 * Debug Description Sync
 * Checks why a product's description hasn't been synced to Shopify.
 *
 * Usage:
 *   node apps/api/src/scripts/debug-description-sync.js <storeId> <productHandle>
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const args = process.argv.slice(2);
const STORE_ID = args[0] || "k8xbf0-5t.myshopify.com";
const PRODUCT_HANDLE = args[1] || "tom-ford-orange-viscose-casual-dress";

async function fetchAccessToken(shop) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shop}`;
  const res = await fetch(url);
  const data = await res.json();
  return data?.data?.accessToken || null;
}

// ─── 1. Check Neo4j ──────────────────────────────────────────────────

async function checkNeo4j() {
  console.log(`\n══ 1. NEO4J CHECK ══`);
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product {handle: $handle, storeId: $storeId})
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.description AS description,
              p.descriptionSource AS descriptionSource,
              p.description_synced_at AS description_synced_at,
              p.updated_at AS updated_at,
              p.lastSeenAt AS lastSeenAt
       LIMIT 1`,
      { handle: PRODUCT_HANDLE, storeId: STORE_ID }
    );

    if (result.records.length === 0) {
      console.log(`  Product "${PRODUCT_HANDLE}" NOT FOUND in Neo4j for store ${STORE_ID}`);
      return null;
    }

    const r = result.records[0];
    const desc = r.get("description");
    const product = {
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      descriptionSource: r.get("descriptionSource"),
      description_synced_at: r.get("description_synced_at"),
      updated_at: r.get("updated_at"),
      lastSeenAt: r.get("lastSeenAt"),
      descriptionLength: desc ? desc.length : 0,
      descriptionPreview: desc ? desc.substring(0, 200) + (desc.length > 200 ? "..." : "") : null,
    };

    console.log(`  FOUND in Neo4j:`);
    console.log(`    ID:                  ${product.id}`);
    console.log(`    Title:               ${product.title}`);
    console.log(`    descriptionSource:   ${product.descriptionSource || "N/A (not set)"}`);
    console.log(`    description_synced_at: ${product.description_synced_at || "N/A (never synced)"}`);
    console.log(`    updated_at:          ${product.updated_at || "N/A"}`);
    console.log(`    lastSeenAt:          ${product.lastSeenAt || "N/A"}`);
    console.log(`    Description length:  ${product.descriptionLength} chars`);
    if (product.descriptionPreview) {
      console.log(`    Description preview: ${product.descriptionPreview}`);
    } else {
      console.log(`    Description:         EMPTY / NULL`);
    }

    if (!desc || desc.trim() === "") {
      console.log(`\n    ⚠ ISSUE: No description in Neo4j — nothing to sync`);
    }
    if (!product.descriptionSource || product.descriptionSource === "original") {
      console.log(`\n    ⚠ ISSUE: descriptionSource is "${product.descriptionSource || "null"}" — sync-shopify-descriptions.js skips these unless --force is used`);
    }
    if (product.description_synced_at) {
      console.log(`\n    ✓ Description was already synced at ${product.description_synced_at}`);
      console.log(`      sync-shopify-descriptions.js with --missing will skip this product`);
    }

    return product;
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── 2. Check Shopify ────────────────────────────────────────────────

async function checkShopify(neo4jProduct) {
  console.log(`\n══ 2. SHOPIFY CHECK ══`);
  const accessToken = await fetchAccessToken(STORE_ID);
  if (!accessToken) {
    console.log(`  Could not fetch access token for ${STORE_ID}`);
    return null;
  }

  const url = `https://${STORE_ID}/admin/api/2023-04/products.json?handle=${PRODUCT_HANDLE}&fields=id,title,handle,body_html,status,published_at`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  if (!res.ok) {
    console.log(`  Shopify API error: ${res.status} ${res.statusText}`);
    return null;
  }

  const data = await res.json();
  if (!data.products || data.products.length === 0) {
    console.log(`  Product "${PRODUCT_HANDLE}" NOT FOUND in Shopify`);
    return null;
  }

  const product = data.products[0];
  const shopifyDesc = product.body_html || "";

  console.log(`  FOUND in Shopify:`);
  console.log(`    ID:              ${product.id}`);
  console.log(`    Title:           ${product.title}`);
  console.log(`    Status:          ${product.status}`);
  console.log(`    Published:       ${product.published_at ? "YES" : "NO"}`);
  console.log(`    Description len: ${shopifyDesc.length} chars`);
  console.log(`    Description preview: ${shopifyDesc.substring(0, 200)}${shopifyDesc.length > 200 ? "..." : ""}`);

  if (neo4jProduct && neo4jProduct.descriptionLength > 0) {
    const neo4jDesc = neo4jProduct.descriptionPreview || "";
    if (shopifyDesc.length === 0) {
      console.log(`\n    ⚠ Shopify has NO description, Neo4j has ${neo4jProduct.descriptionLength} chars`);
    } else if (shopifyDesc === neo4jProduct.descriptionPreview?.replace("...", "")) {
      console.log(`\n    ✓ Descriptions appear to match`);
    } else {
      console.log(`\n    ⚠ Descriptions DIFFER between Neo4j and Shopify`);
    }
  }

  return product;
}

// ─── 3. Diagnosis ────────────────────────────────────────────────────

function diagnose(neo4jProduct) {
  console.log(`\n══ 3. DIAGNOSIS ══`);

  if (!neo4jProduct) {
    console.log(`  Product not found in Neo4j. It needs to be synced first (Step 1 of the pipeline).`);
    return;
  }

  const issues = [];

  if (!neo4jProduct.descriptionLength || neo4jProduct.descriptionLength === 0) {
    issues.push("No AI description generated yet in Neo4j. The sync-modular.js (Step 1) with --rewrite-descriptions needs to generate it first.");
  }

  if (!neo4jProduct.descriptionSource || neo4jProduct.descriptionSource === "original") {
    issues.push(`descriptionSource is "${neo4jProduct.descriptionSource || "null"}". sync-shopify-descriptions.js only pushes descriptions where descriptionSource is NOT "original" (unless --force is used). The AI description generator needs to set this field.`);
  }

  if (neo4jProduct.description_synced_at) {
    issues.push(`description_synced_at is set (${neo4jProduct.description_synced_at}). Running sync-shopify-descriptions.js with --missing will skip this product because it was already synced. Use without --missing to re-sync, or clear this field.`);
  }

  if (issues.length === 0) {
    console.log(`  No issues found — the description should sync on next run of sync-shopify-descriptions.js`);
  } else {
    issues.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue}`);
    });
  }

  console.log("");
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  Debug Description Sync                                   ║`);
  console.log(`║  Store:   ${STORE_ID.padEnd(46)}║`);
  console.log(`║  Handle:  ${PRODUCT_HANDLE.padEnd(46)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════╝`);

  const neo4jProduct = await checkNeo4j();
  await checkShopify(neo4jProduct);
  diagnose(neo4jProduct);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
