#!/usr/bin/env node

/**
 * Get a Toff product creation date by handle or URL
 *
 * Usage:
 *   node apps/api/src/scripts/test-toff-creation-date.js <handle-or-url>
 *
 * Examples:
 *   node apps/api/src/scripts/test-toff-creation-date.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
 *   node apps/api/src/scripts/test-toff-creation-date.js https://www.toff.ro/philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202/p
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
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
Usage: node test-toff-creation-date.js <handle-or-url>

Examples:
  node test-toff-creation-date.js philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202
  node test-toff-creation-date.js https://www.toff.ro/philipp-plein-jacheta-neagra-cu-logo-safcmjb3877pte003n0202/p
  `);
  process.exit(1);
}

const urlMatch = handleInput.match(/toff\.ro\/([^/]+)\/p/);
const handle = urlMatch ? urlMatch[1] : handleInput;

function formatDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Toff Product — Creation Date Lookup`);
  console.log(`  Handle: ${handle}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // Step 1: Search by handle to get the productId
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
  const productId = product.productId;

  console.log(`  Found: ${product.productName} (ID: ${productId})\n`);

  // Step 2: Fetch from private Catalog API for CreationDate
  console.log(`[2] Fetching catalog details for product ${productId}...\n`);
  const catalogUrl = `${BASE_URL}/api/catalog/pvt/product/${productId}`;
  const catalogRes = await fetch(catalogUrl, { headers: HEADERS });

  if (!catalogRes.ok) {
    console.log(`  Catalog API returned ${catalogRes.status} — using search data only.\n`);
    console.log(`  ┌────────────────────────────────────────────────────────┐`);
    console.log(`  │  Product:       ${product.productName}`);
    console.log(`  │  Handle:        ${product.linkText}`);
    console.log(`  │  Release Date:  ${formatDate(product.releaseDate)}`);
    console.log(`  └────────────────────────────────────────────────────────┘\n`);
    return;
  }

  const catalog = await catalogRes.json();

  // Availability from search API
  const items = product.items || [];
  const totalSkus = items.length;
  let availableSkus = 0;
  let totalStock = 0;

  for (const item of items) {
    const seller = item.sellers?.find(s => s.commertialOffer?.IsAvailable) || item.sellers?.[0];
    const offer = seller?.commertialOffer || {};
    if (offer.IsAvailable) availableSkus++;
    totalStock += (offer.AvailableQuantity || 0);
  }

  const isActive = catalog.IsActive ?? "N/A";
  const isVisible = catalog.IsVisible ?? "N/A";
  const showWithoutStock = catalog.ShowWithoutStock ?? "N/A";
  const availableLabel = availableSkus > 0 ? `YES (${availableSkus}/${totalSkus} SKUs)` : `NO (0/${totalSkus} SKUs)`;

  // Step 3: Display results
  console.log(`  ┌──────────────────────────────────────────────────────────────┐`);
  console.log(`  │  PRODUCT INFO                                               │`);
  console.log(`  ├──────────────────────────────────────────────────────────────┤`);
  console.log(`  │  Name:             ${product.productName}`);
  console.log(`  │  ID:               ${productId}`);
  console.log(`  │  Handle:           ${product.linkText}`);
  console.log(`  │  Brand:            ${product.brand}`);
  console.log(`  │  Categories:       ${(product.categories || []).join(" > ")}`);
  console.log(`  │                                                              │`);
  console.log(`  │  DATES                                                       │`);
  console.log(`  ├──────────────────────────────────────────────────────────────┤`);
  console.log(`  │  Created:          ${formatDate(catalog.CreationDate)}`);
  console.log(`  │  Last Modified:    ${formatDate(catalog.LastModifiedDate)}`);
  console.log(`  │  Release Date:     ${formatDate(catalog.ReleaseDate)}`);
  console.log(`  │                                                              │`);
  console.log(`  │  STATUS & AVAILABILITY                                       │`);
  console.log(`  ├──────────────────────────────────────────────────────────────┤`);
  console.log(`  │  Active:           ${isActive}`);
  console.log(`  │  Visible on site:  ${isVisible}`);
  console.log(`  │  Show w/o stock:   ${showWithoutStock}`);
  console.log(`  │  Available:        ${availableLabel}`);
  console.log(`  │  Total stock:      ${totalStock}`);
  console.log(`  └──────────────────────────────────────────────────────────────┘`);

  console.log(`\n  Raw dates:`);
  console.log(`    CreationDate:     ${catalog.CreationDate || "N/A"}`);
  console.log(`    LastModifiedDate: ${catalog.LastModifiedDate || "N/A"}`);
  console.log(`    ReleaseDate:      ${catalog.ReleaseDate || "N/A"}`);

  if (totalSkus > 0) {
    console.log(`\n  SKU breakdown:`);
    for (const item of items) {
      const seller = item.sellers?.find(s => s.commertialOffer?.IsAvailable) || item.sellers?.[0];
      const offer = seller?.commertialOffer || {};
      const status = offer.IsAvailable ? "AVAILABLE" : "UNAVAILABLE";
      const stock = offer.AvailableQuantity || 0;
      const price = offer.Price ? `${offer.Price} ${product.items?.[0]?.sellers?.[0]?.commertialOffer?.CurrencySymbolPosition ? "" : ""}` : "N/A";
      console.log(`    ${item.itemId}: ${item.name || item.nameComplete}  —  ${status}  |  stock: ${stock}  |  price: ${price}`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
