#!/usr/bin/env node

/**
 * Test Toff Product Images — compare images from VTEX vs what's saved in Neo4j
 *
 * Usage:
 *   node apps/api/src/scripts/test-toff-product-images.js <handle-or-url>
 *
 * Examples:
 *   node apps/api/src/scripts/test-toff-product-images.js valentino-garavani-rochie-candy-couture-7b3vadt01mmd1k
 *   node apps/api/src/scripts/test-toff-product-images.js https://www.toff.ro/valentino-garavani-rochie-candy-couture-7b3vadt01mmd1k/p
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;

const STORE_ID = `${accountName}.vtexcommercestable.com.br`;
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
Usage: node test-toff-product-images.js <handle-or-url>

Examples:
  node test-toff-product-images.js valentino-garavani-rochie-candy-couture-7b3vadt01mmd1k
  node test-toff-product-images.js https://www.toff.ro/valentino-garavani-rochie-candy-couture-7b3vadt01mmd1k/p
  `);
  process.exit(1);
}

const urlMatch = handleInput.match(/toff\.ro\/([^/]+)\/p/);
const handle = urlMatch ? urlMatch[1] : handleInput;

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function fetchVtexProduct() {
  const searchUrl = `${BASE_URL}/api/catalog_system/pub/products/search/${handle}/p`;
  const res = await fetch(searchUrl, { headers: HEADERS });
  if (!res.ok) throw new Error(`VTEX search failed: ${res.status} ${await res.text()}`);
  const arr = await res.json();
  return arr[0] || null;
}

async function fetchNeo4jProduct() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId AND p.handle = $handle
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.image AS image, p.images AS images,
              p.descriptionSource AS descriptionSource, p.updated_at AS updatedAt`,
      { storeId: STORE_ID, handle }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      image: r.get("image"),
      images: r.get("images") || [],
      descriptionSource: r.get("descriptionSource"),
      updatedAt: r.get("updatedAt"),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

function transformLikeProvider(product) {
  // Mirrors apps/api/src/sync/providers/vtex.js (transformSearchProduct)
  const availableItems = (product.items || []).filter(item =>
    item.sellers?.some(seller => seller.commertialOffer?.IsAvailable)
  );
  const mainItem = availableItems[0] || product.items?.[0] || {};
  const images = mainItem.images?.map(img => ({
    src: img.imageUrl,
    alt: img.imageText || img.imageLabel || "",
  })) || [];
  return {
    mainItemId: mainItem.itemId,
    mainItemName: mainItem.name || mainItem.nameComplete,
    images,
    image: images[0]?.src || null,
  };
}

function listAllItemImages(product) {
  return (product.items || []).map(item => ({
    itemId: item.itemId,
    name: item.name || item.nameComplete,
    isAvailable: item.sellers?.some(s => s.commertialOffer?.IsAvailable) || false,
    images: (item.images || []).map(img => ({
      imageId: img.imageId,
      imageUrl: img.imageUrl,
      imageText: img.imageText || img.imageLabel || "",
    })),
  }));
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Toff Product Image Comparison`);
  console.log(`  Handle:    ${handle}`);
  console.log(`  Store ID:  ${STORE_ID}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // ── 1. VTEX RAW ────────────────────────────────────────────────────
  console.log(`[1] Fetching from VTEX...\n`);
  const vtexProduct = await fetchVtexProduct();
  if (!vtexProduct) {
    console.error(`  Product not found in VTEX for handle "${handle}"`);
    process.exit(1);
  }

  console.log(`  VTEX productId: ${vtexProduct.productId}`);
  console.log(`  VTEX productName: ${vtexProduct.productName}`);
  console.log(`  Items (SKUs): ${vtexProduct.items?.length || 0}\n`);

  // ── 2. ALL images per item (raw VTEX) ──────────────────────────────
  console.log(`[2] All images per VTEX item (raw):\n`);
  const allItemImages = listAllItemImages(vtexProduct);
  for (const it of allItemImages) {
    console.log(`  ── Item ${it.itemId} (${it.name}) [available: ${it.isAvailable}] — ${it.images.length} image(s)`);
    for (const img of it.images) {
      console.log(`     • [${img.imageId}] ${img.imageUrl}`);
      if (img.imageText) console.log(`       alt: ${img.imageText}`);
    }
  }

  // ── 3. What the provider would extract ─────────────────────────────
  console.log(`\n[3] What the VTEX provider would transform (transformSearchProduct):\n`);
  const transformed = transformLikeProvider(vtexProduct);
  console.log(`  mainItem chosen: ${transformed.mainItemId} (${transformed.mainItemName})`);
  console.log(`  product.image:   ${transformed.image}`);
  console.log(`  product.images (${transformed.images.length}):`);
  for (let i = 0; i < transformed.images.length; i++) {
    console.log(`     [${i}] ${transformed.images[i].src}`);
    if (transformed.images[i].alt) console.log(`         alt: ${transformed.images[i].alt}`);
  }

  // ── 4. What's saved in Neo4j ───────────────────────────────────────
  console.log(`\n[4] Reading from Neo4j (Product with storeId=${STORE_ID}, handle=${handle})...\n`);
  const neoProduct = await fetchNeo4jProduct();
  if (!neoProduct) {
    console.log(`  ✗ Product NOT found in Neo4j.`);
  } else {
    console.log(`  Neo4j Product.id:                ${neoProduct.id}`);
    console.log(`  Neo4j Product.title:             ${neoProduct.title}`);
    console.log(`  Neo4j Product.descriptionSource: ${neoProduct.descriptionSource}`);
    console.log(`  Neo4j Product.updated_at:        ${neoProduct.updatedAt}`);
    console.log(`\n  Neo4j Product.image:`);
    console.log(`     ${neoProduct.image || "(null)"}`);
    console.log(`\n  Neo4j Product.images (${neoProduct.images.length}):`);
    for (let i = 0; i < neoProduct.images.length; i++) {
      console.log(`     [${i}] ${neoProduct.images[i]}`);
    }
  }

  // ── 5. Diff ────────────────────────────────────────────────────────
  if (neoProduct) {
    console.log(`\n[5] Diff (transformed VTEX vs Neo4j):\n`);
    const vtexUrls = transformed.images.map(i => i.src);
    const neoUrls = neoProduct.images;

    const onlyInVtex = vtexUrls.filter(u => !neoUrls.includes(u));
    const onlyInNeo = neoUrls.filter(u => !vtexUrls.includes(u));
    const both = vtexUrls.filter(u => neoUrls.includes(u));

    console.log(`  ✓ In both:           ${both.length}`);
    console.log(`  + Only in VTEX now:  ${onlyInVtex.length}`);
    if (onlyInVtex.length) onlyInVtex.forEach(u => console.log(`     + ${u}`));
    console.log(`  - Only in Neo4j:     ${onlyInNeo.length}`);
    if (onlyInNeo.length) onlyInNeo.forEach(u => console.log(`     - ${u}`));

    console.log(`\n  Primary image match: ${transformed.image === neoProduct.image ? "✓ YES" : "✗ NO"}`);
    if (transformed.image !== neoProduct.image) {
      console.log(`     VTEX:  ${transformed.image}`);
      console.log(`     Neo4j: ${neoProduct.image}`);
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
