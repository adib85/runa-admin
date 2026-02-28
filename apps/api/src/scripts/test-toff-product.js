#!/usr/bin/env node

/**
 * Test Toff Product — look up a product by handle and show its data
 *
 * Usage:
 *   node apps/api/src/scripts/test-toff-product.js <handle-or-url>
 *
 * Examples:
 *   node apps/api/src/scripts/test-toff-product.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
 *   node apps/api/src/scripts/test-toff-product.js https://www.toff.ro/philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202/p
 */

import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;

const BASE_URL = `https://${accountName}.vtexcommercestable.com.br`;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
};

let handleInput = process.argv[2];

if (!handleInput) {
  console.error(`
Usage: node test-toff-product.js <handle-or-url>

Examples:
  node test-toff-product.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
  node test-toff-product.js https://www.toff.ro/philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202/p
  `);
  process.exit(1);
}

const urlMatch = handleInput.match(/toff\.ro\/([^/]+)\/p/);
const handle = urlMatch ? urlMatch[1] : handleInput;

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Toff Product Lookup`);
  console.log(`  Handle: ${handle}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // 1. Search for the product by handle (linkText)
  console.log(`[1] Searching VTEX for handle "${handle}"...\n`);
  const searchUrl = `${BASE_URL}/api/catalog_system/pub/products/search/${handle}/p`;
  const searchRes = await fetch(searchUrl, { headers: HEADERS });

  if (!searchRes.ok) {
    console.error(`  Search failed: ${searchRes.status} ${await searchRes.text()}`);
    process.exit(1);
  }

  const products = await searchRes.json();

  if (products.length === 0) {
    console.log(`  Product not found for handle "${handle}"`);
    return;
  }

  const product = products[0];

  // 2. Show product data
  console.log(`[2] Product Data:\n`);
  console.log(`  ID:                 ${product.productId}`);
  console.log(`  Name:               ${product.productName}`);
  console.log(`  Brand:              ${product.brand} (id: ${product.brandId})`);
  console.log(`  Handle (linkText):  ${product.linkText}`);
  console.log(`  Product Reference:  ${product.productReference}`);
  console.log(`  Categories:         ${(product.categories || []).join(" > ")}`);
  console.log(`  Release Date:       ${product.releaseDate}`);

  const desc = (product.description || "").trim();
  console.log(`  Description:        ${desc.length > 0 ? `${desc.length} chars` : "EMPTY"}`);
  if (desc.length > 0) {
    console.log(`  Description preview: ${desc.substring(0, 200)}...`);
  }

  // 3. Show SKUs / items
  const items = product.items || [];
  console.log(`\n[3] SKUs / Items (${items.length}):\n`);

  for (const item of items) {
    const refId = item.referenceId?.[0]?.Value || "N/A";
    const ean = item.ean || "N/A";
    const seller = item.sellers?.find(s => s.commertialOffer?.IsAvailable) || item.sellers?.[0];
    const offer = seller?.commertialOffer || {};

    console.log(`  ── Item ${item.itemId}: ${item.name || item.nameComplete}`);
    console.log(`     Reference ID (SKU): ${refId}`);
    console.log(`     EAN:                ${ean}`);
    console.log(`     Price:              ${offer.Price || "N/A"}`);
    console.log(`     List Price:         ${offer.ListPrice || "N/A"}`);
    console.log(`     Available:          ${offer.IsAvailable || false}`);
    console.log(`     Stock:              ${offer.AvailableQuantity || 0}`);

    if (item.variations?.length > 0) {
      for (const v of item.variations) {
        if (v.name && v.values) {
          console.log(`     ${v.name}: ${v.values.join(", ")}`);
        }
      }
    }
    console.log();
  }

  // 4. First SKU (what would be saved to Neo4j)
  const firstItem = items[0];
  const firstSku = firstItem?.referenceId?.[0]?.Value || firstItem?.ean || "N/A";
  console.log(`[4] First variant SKU (saved to Product.sku): ${firstSku}`);

  console.log(`\n═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
