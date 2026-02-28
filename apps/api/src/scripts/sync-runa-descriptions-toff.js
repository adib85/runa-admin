#!/usr/bin/env node

/**
 * Sync Runa Descriptions for Toff Products
 *
 * Fetches all Toff products from Neo4j where descriptionSource != "original",
 * then generates a description using Gemini:
 *   1. Google Search grounding (search by SKU/handle)
 *   2. Fallback: generate from product image via Gemini vision
 *
 * Updates Neo4j with the generated description.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-runa-descriptions-toff.js [--dry-run] [--limit N]
 *   node apps/api/src/scripts/sync-runa-descriptions-toff.js --handle <handle-or-url>
 */

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";
import { generateAIDescription } from "../sync/services/ai-product-description.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_ID = "toffro.vtexcommercestable.com.br";

const RATE_LIMIT_MS = 1500;
const PROGRESS_FILE = path.resolve(__dirname, "../../.sync-desc-progress-toff.json");

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const handleIdx = args.indexOf("--handle");
let singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;
if (singleHandle) {
  const urlMatch = singleHandle.match(/toff\.ro\/([^/]+)\/p/);
  if (urlMatch) singleHandle = urlMatch[1];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    }
  } catch { }
  return { processedIds: [] };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress), "utf8");
}

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getProductsNeedingDescription() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product) WHERE p.storeId = $storeId
       AND (p.descriptionSource IS NULL OR p.descriptionSource = "" OR NOT p.descriptionSource IN ["original", "google_search", "ai_image"])
       OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category)
       RETURN p.id AS id, p.title AS title, p.description AS description,
              p.descriptionSource AS descriptionSource, p.handle AS handle,
              p.image AS image, p.images AS images, p.sku AS sku,
              p.vendor AS vendor,
              collect(DISTINCT c.name) AS categories
       ORDER BY p.title`,
      { storeId: STORE_ID }
    );
    return result.records.map(r => mapRecord(r));
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
      `MATCH (p:Product) WHERE p.storeId = $storeId AND p.handle = $handle
       OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category)
       RETURN p.id AS id, p.title AS title, p.description AS description,
              p.descriptionSource AS descriptionSource, p.handle AS handle,
              p.image AS image, p.images AS images, p.sku AS sku,
              p.vendor AS vendor,
              collect(DISTINCT c.name) AS categories`,
      { storeId: STORE_ID, handle }
    );
    if (result.records.length === 0) return null;
    return mapRecord(result.records[0]);
  } finally {
    await session.close();
    await driver.close();
  }
}

function mapRecord(r) {
  return {
    id: r.get("id"),
    title: r.get("title"),
    description: r.get("description"),
    descriptionSource: r.get("descriptionSource"),
    handle: r.get("handle"),
    image: r.get("image"),
    images: r.get("images"),
    sku: r.get("sku"),
    vendor: r.get("vendor"),
    categories: r.get("categories") || [],
  };
}

async function updateNeo4jDescription(productId, description, source) {
  const driver = getDriver();
  const session = driver.session();
  try {
    await session.run(
      `MATCH (p:Product {id: $productId})
       SET p.description = $description, p.descriptionSource = $source, p.updated_at = $now`,
      { productId, description, source, now: new Date().toISOString() }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// AI description functions imported from shared module:
// buildDescriptionPrompt, searchWithGrounding, parseSearchResult,
// generateDescriptionFromImage, generateAIDescription

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Sync Runa Descriptions — Toff`);
  console.log(`  Store:      ${STORE_ID}`);
  console.log(`  Mode:       ${dryRun ? "DRY RUN" : "LIVE"}`);
  if (singleHandle) console.log(`  Handle:     ${singleHandle}`);
  if (limit) console.log(`  Limit:      ${limit} products`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  let toProcess;

  if (singleHandle) {
    // Single product mode
    console.log(`[1] Looking up handle "${singleHandle}" in Neo4j...`);
    const product = await getProductByHandle(singleHandle);
    if (!product) {
      console.log(`    Product not found in Neo4j for handle "${singleHandle}"`);
      return;
    }
    console.log(`    Found: "${product.title}" (id: ${product.id}, descriptionSource: ${product.descriptionSource || "null"})\n`);
    toProcess = [product];
  } else {
    // Batch mode
    const progress = loadProgress();
    console.log(`[1] Fetching products from Neo4j where descriptionSource != "original"...`);
    const products = await getProductsNeedingDescription();
    console.log(`    Found ${products.length} products needing descriptions\n`);

    const alreadyDone = new Set(progress.processedIds || []);
    const remaining = products.filter(p => !alreadyDone.has(p.id));
    console.log(`    Already processed: ${alreadyDone.size}, remaining: ${remaining.length}\n`);

    if (remaining.length === 0) {
      console.log("Nothing to do — all products already processed.");
      return;
    }

    toProcess = limit ? remaining.slice(0, limit) : remaining;
  }

  // 2. Process each product
  const stats = { processed: 0, generated: 0, googleSearch: 0, aiImage: 0, failed: 0 };

  for (const product of toProcess) {
    stats.processed++;
    const tag = `[${stats.processed}/${toProcess.length}]`;

    console.log(`\n${tag} ─── "${product.title}" (id: ${product.id}) ───`);
    console.log(`     descriptionSource: ${product.descriptionSource || "null"}, handle: ${product.handle}`);

    if (dryRun) {
      console.log(`     [DRY RUN] Would generate description`);
      continue;
    }

    try {
      const aiResult = await generateAIDescription(product);

      if (aiResult) {
        stats.generated++;
        if (aiResult.source === "google_search") stats.googleSearch++;
        if (aiResult.source === "ai_image") stats.aiImage++;

        await updateNeo4jDescription(product.id, aiResult.text, aiResult.source);
        console.log(`  [Neo4j] ✓ Updated description (${aiResult.text.length} chars, source: ${aiResult.source})`);

      } else {
        stats.failed++;
      }

      if (!singleHandle) {
        const progress = loadProgress();
        progress.processedIds = [...(progress.processedIds || []), product.id];
        saveProgress(progress);
      }

    } catch (error) {
      console.error(`  ✗ Error processing "${product.title}": ${error.message}`);
      stats.failed++;
    }

    await delay(RATE_LIMIT_MS);
  }

  // 3. Summary
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Processed:              ${stats.processed}`);
  console.log(`    Descriptions generated: ${stats.generated}`);
  console.log(`      via Google Search:    ${stats.googleSearch}`);
  console.log(`      via Image (AI):       ${stats.aiImage}`);
  console.log(`    Failed / no result:     ${stats.failed}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
