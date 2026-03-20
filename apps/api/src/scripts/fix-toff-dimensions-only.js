#!/usr/bin/env node

/**
 * One-time fix: Find products with dimension-only descriptions in Neo4j,
 * generate proper AI descriptions, regenerate contentEmbedding, and update Neo4j.
 *
 * After running this, run sync-toff-descriptions.js to push to VTEX.
 *
 * Usage:
 *   node apps/api/src/scripts/fix-toff-dimensions-only.js --dry-run
 *   node apps/api/src/scripts/fix-toff-dimensions-only.js
 */

import neo4j from "neo4j-driver";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";
import { generateAIDescription, isBagProduct } from "../sync/services/ai-product-description.js";
import openai from "../sync/services/openai.js";

const STORE_ID = "toffro.vtexcommercestable.com.br";
const RATE_LIMIT_MS = 1500;
const dryRun = process.argv.includes("--dry-run");

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Fix Toff Dimensions-Only Descriptions`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  const driver = getDriver();
  const session = driver.session();

  try {
    console.log(`[1] Finding products with dimension-only descriptions...\n`);

    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.description IS NOT NULL
         AND trim(p.description) <> ""
         AND size(trim(p.description)) <= 100
         AND trim(p.description) =~ '(?i)^\\\\s*dimensiuni.*'
       RETURN p.id AS id, p.title AS title, p.description AS description,
              p.descriptionSource AS descriptionSource, p.handle AS handle,
              p.image AS image, p.images AS images, p.sku AS sku,
              p.vendor AS vendor`,
      { storeId: STORE_ID }
    );

    const allMatches = result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      description: r.get("description"),
      descriptionSource: r.get("descriptionSource"),
      handle: r.get("handle"),
      image: r.get("image"),
      images: r.get("images"),
      sku: r.get("sku"),
      vendor: r.get("vendor"),
    }));

    const products = allMatches.filter(p => isBagProduct(p.title));
    const skipped = allMatches.length - products.length;
    if (skipped > 0) {
      console.log(`Skipping ${skipped} non-bag products (books, wallets, etc.)\n`);
    }

    console.log(`Found ${products.length} products with dimensions-only descriptions:\n`);

    for (const p of products) {
      console.log(`  - "${p.title}" → "${p.description}"`);
    }

    if (products.length === 0) {
      console.log("\nNothing to fix.");
      return;
    }

    if (dryRun) {
      console.log(`\n[DRY RUN] Would generate descriptions + embeddings for ${products.length} products.`);
      return;
    }

    console.log(`\n[2] Generating descriptions and updating Neo4j...\n`);

    const stats = { processed: 0, generated: 0, failed: 0 };

    for (const product of products) {
      stats.processed++;
      const tag = `[${stats.processed}/${products.length}]`;
      const dimensionsText = product.description.replace(/<[^>]*>/g, "").trim();

      console.log(`\n${tag} ─── "${product.title}" ───`);
      console.log(`     dimensions: "${dimensionsText}"`);

      try {
        const aiProduct = {
          title: product.title,
          sku: product.sku,
          vendor: product.vendor,
          image: product.image,
          images: product.images,
          dimensionsText,
        };

        const aiResult = await generateAIDescription(aiProduct);

        if (aiResult && aiResult.text) {
          stats.generated++;

          const content = `${product.title}. ${aiResult.text}`;
          const contentEmbedding = await openai.generateEmbedding(content);

          const updateSession = driver.session();
          try {
            await updateSession.run(
              `MATCH (p:Product {id: $productId, storeId: $storeId})
               SET p.description = $description,
                   p.descriptionSource = $source,
                   p.content = $content,
                   p.contentEmbedding = $contentEmbedding,
                   p.updated_at = $now`,
              {
                productId: product.id,
                storeId: STORE_ID,
                description: aiResult.text,
                source: aiResult.source,
                content,
                contentEmbedding,
                now: new Date().toISOString(),
              }
            );
          } finally {
            await updateSession.close();
          }

          console.log(`  ✓ Generated (${aiResult.text.length} chars, ${aiResult.source}) + embedding updated`);
        } else {
          stats.failed++;
          console.log(`  ✗ AI returned no result`);
        }
      } catch (error) {
        stats.failed++;
        console.error(`  ✗ Error: ${error.message}`);
      }

      await delay(RATE_LIMIT_MS);
    }

    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`  RESULTS`);
    console.log(`    Processed:   ${stats.processed}`);
    console.log(`    Generated:   ${stats.generated}`);
    console.log(`    Failed:      ${stats.failed}`);
    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`\n  Next: run sync-toff-descriptions.js to push to VTEX.\n`);

  } finally {
    await session.close();
    await driver.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
