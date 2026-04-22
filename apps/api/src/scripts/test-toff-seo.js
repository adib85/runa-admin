#!/usr/bin/env node

/**
 * Test Toff SEO generation on a single product.
 *
 * Fetches the product from VTEX by handle, then calls generateSEO() with the
 * product data and prints the resulting Title and MetaTagDescription so you
 * can verify the new TOFF rules are applied correctly.
 *
 * With --save, also writes seoTitle and seoMetaDescription into the Neo4j
 * Product node (so that sync-toff-seo.js can subsequently push them to VTEX).
 *
 * Usage:
 *   node apps/api/src/scripts/test-toff-seo.js <handle-or-url> [--save]
 *
 * Examples:
 *   node apps/api/src/scripts/test-toff-seo.js acne-studios-rochie-camasa-cu-esarfa-aplicata-a20937-dlc
 *   node apps/api/src/scripts/test-toff-seo.js acne-studios-rochie-camasa-cu-esarfa-aplicata-a20937-dlc --save
 *   node apps/api/src/scripts/test-toff-seo.js https://www.toff.ro/acne-studios-rochie-camasa-cu-esarfa-aplicata-a20937-dlc/p --save
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import fetch from "node-fetch";
import neo4j from "neo4j-driver";
import { generateSEO } from "../sync/services/ai-product-description.js";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

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

const args = process.argv.slice(2);
const save = args.includes("--save");
let handleInput = args.find(a => !a.startsWith("--"));
if (!handleInput) {
  console.error(`\nUsage: node test-toff-seo.js <handle-or-url> [--save]\n`);
  process.exit(1);
}
const urlMatch = handleInput.match(/toff\.ro\/([^/]+)\/p/);
const handle = urlMatch ? urlMatch[1] : handleInput;
const STORE_ID = `${accountName}.vtexcommercestable.com.br`;

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Test Toff SEO Generation`);
  console.log(`  Handle: ${handle}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Fetching product from VTEX search API...`);
  const searchUrl = `${BASE_URL}/api/catalog_system/pub/products/search/${handle}/p`;
  const searchRes = await fetch(searchUrl, { headers: HEADERS });
  if (!searchRes.ok) {
    console.error(`    Search failed: ${searchRes.status}`);
    process.exit(1);
  }
  const products = await searchRes.json();
  if (!products.length) {
    console.error(`    Product not found for handle "${handle}"`);
    process.exit(1);
  }
  const product = products[0];
  console.log(`    Found: "${product.productName}" (id: ${product.productId})`);
  console.log(`    Brand: ${product.brand}`);
  console.log(`    Categories: ${(product.categories || []).join(" > ")}`);

  const firstCategory = (product.categories || [])[0]?.toLowerCase() || '';
  const demographics = [];
  if (firstCategory.startsWith('/femei/')) demographics.push('woman');
  if (firstCategory.startsWith('/bărbați/')) demographics.push('man');
  if (demographics.length === 0) demographics.push('unisex');

  const productType = (product.categories || [])
    .map(c => c.replace(/^\/|\/$/g, '').split('/').pop())
    .filter(Boolean)
    .pop() || "";

  console.log(`    Detected demographic: ${demographics.join(", ")}`);
  console.log(`    Product type: "${productType}"\n`);

  console.log(`[2] Existing VTEX SEO fields:`);
  const detailRes = await fetch(`${BASE_URL}/api/catalog/pvt/product/${product.productId}`, { headers: HEADERS });
  if (detailRes.ok) {
    const detail = await detailRes.json();
    console.log(`    Current Title:               "${detail.Title || '(empty)'}"`);
    console.log(`    Current MetaTagDescription:  "${(detail.MetaTagDescription || '(empty)').substring(0, 120)}..."\n`);
  }

  console.log(`[3] Calling generateSEO()...`);
  const seoInput = {
    title: product.productName,
    vendor: product.brand,
    product_type: productType,
    categories: (product.categories || []).map(c => c.replace(/^\/|\/$/g, '').split('/').pop()).filter(Boolean),
    demographics,
    description: product.description || "",
  };

  const seoResult = await generateSEO(seoInput, { language: "ro" });

  if (!seoResult) {
    console.error(`\n    ✗ generateSEO returned null`);
    process.exit(1);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  GENERATED SEO`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`\n  Title (${seoResult.title.length}/50 chars):`);
  console.log(`    "${seoResult.title}"`);
  console.log(`    ${seoResult.title.length <= 50 ? '✓ within 50 char limit' : '✗ EXCEEDS 50 chars'}`);
  console.log(`    ${/\|\s*TOFF\.ro$/i.test(seoResult.title) ? '✓ ends with "| TOFF.ro"' : '✗ MISSING "| TOFF.ro" suffix'}`);
  console.log(`    NOTE: storefront currently appends " - TOFF.ro" automatically → on-page becomes`);
  console.log(`          "${seoResult.title} - TOFF.ro" (will be fixed once storefront removes auto-suffix)`);

  console.log(`\n  MetaTagDescription (${seoResult.metaDescription.length}/120-160 chars):`);
  console.log(`    "${seoResult.metaDescription}"`);
  console.log(`    ${seoResult.metaDescription.length >= 120 && seoResult.metaDescription.length <= 160 ? '✓ within 120-160 char range' : '✗ OUTSIDE 120-160 char range'}`);
  console.log(`    ${seoResult.metaDescription.includes('⭐') ? '✓ contains ⭐ separator' : '⚠ no ⭐ separator'}`);

  const banned = ["premium", "fuziune", "haute couture", "vârf migdalat"];
  const foundBanned = banned.filter(w => 
    seoResult.title.toLowerCase().includes(w) || seoResult.metaDescription.toLowerCase().includes(w)
  );
  console.log(`\n  Banned words check:`);
  if (foundBanned.length === 0) {
    console.log(`    ✓ no banned words found`);
  } else {
    console.log(`    ✗ FOUND banned words: ${foundBanned.join(", ")}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════\n`);

  if (save) {
    console.log(`[4] Saving SEO to Neo4j...`);
    const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (p:Product {id: $id, storeId: $storeId})
         SET p.seoTitle = $seoTitle,
             p.seoMetaDescription = $seoMetaDescription,
             p.seoSource = $seoSource,
             p.updated_at = $now
         RETURN p.id AS id`,
        {
          id: String(product.productId),
          storeId: STORE_ID,
          seoTitle: seoResult.title,
          seoMetaDescription: seoResult.metaDescription,
          seoSource: seoResult.source,
          now: new Date().toISOString(),
        }
      );
      if (result.records.length === 0) {
        console.log(`    ✗ Product ${product.productId} not found in Neo4j for store ${STORE_ID} — nothing saved.`);
        console.log(`    (Run sync-modular.js first to ensure the product exists in Neo4j.)`);
      } else {
        console.log(`    ✓ Saved seoTitle and seoMetaDescription on Neo4j Product ${product.productId}`);
        console.log(`\n    Next step: push to VTEX with`);
        console.log(`      node apps/api/src/scripts/sync-toff-seo.js --handle ${handle}`);
      }
    } finally {
      await session.close();
      await driver.close();
    }
    console.log(`\n═══════════════════════════════════════════════════════════\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
