#!/usr/bin/env node

/**
 * Backfill heroImage for products already in Neo4j.
 *
 * Reads each product's image array from Neo4j (no Shopify hits required),
 * runs ShopifyProvider.pickHeroImage (Gemini multi-image vision), and writes
 * heroImage / heroImageIndex / heroImageSource / heroImageDecidedAt back to
 * the Product node.
 *
 * Use this to enrich products synced before the hero-picker existed, or after
 * tweaking the prompt. The regular sync runs the picker for new products
 * automatically — this is just for the existing tail.
 *
 * Usage:
 *   node apps/api/src/scripts/pick-hero-images.js                      # all eligible Bronze Snake products
 *   node apps/api/src/scripts/pick-hero-images.js --max 10 --dry-run   # smoke test
 *   node apps/api/src/scripts/pick-hero-images.js --force              # rewrite even existing heroes
 *   node apps/api/src/scripts/pick-hero-images.js --collection womens-jackets-coats
 *   node apps/api/src/scripts/pick-hero-images.js --concurrency 5
 *
 * Cost estimate: ~$0.001 per product (one Gemini multi-image call).
 * For Bronze Snake's ~3,400 products: ~$3.40 total, ~10 minutes at concurrency 5.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { ShopifyProvider } from "../sync/providers/shopify.js";
import { mapWithConcurrency } from "../sync/utils/index.js";

const SHOP = "bronze-snake-1.myshopify.com";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const maxIdx = args.indexOf("--max");
const MAX = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : null;
const collIdx = args.indexOf("--collection");
const ONLY_COLLECTION = collIdx !== -1 ? args[collIdx + 1] : null;
const concIdx = args.indexOf("--concurrency");
const CONCURRENCY = concIdx !== -1 ? parseInt(args[concIdx + 1], 10) : 5;

const driver = neo4j.driver(
  process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
  neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
);

async function fetchProducts(session) {
  const where = [];
  where.push(`p.images IS NOT NULL AND size(p.images) >= 2`);
  if (!FORCE) where.push(`p.heroImage IS NULL`);
  let collMatch = "";
  let collParams = {};
  if (ONLY_COLLECTION) {
    collMatch = `AND EXISTS { (p)-[:HAS_CATEGORY]->(:Category {name: $coll}) }`;
    collParams = { coll: ONLY_COLLECTION };
  }

  const cypher = `
    MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
    WHERE ${where.join(" AND ")} ${collMatch}
    RETURN p.id AS id, p.handle AS handle, p.title AS title,
           p.product_type AS productType, p.vendor AS vendor,
           p.images AS images, p.heroImage AS currentHero
    ORDER BY p.handle
    ${MAX ? `LIMIT $max` : ""}
  `;
  const params = { shop: SHOP, ...collParams };
  if (MAX) params.max = neo4j.int(MAX);

  const r = await session.run(cypher, params);
  return r.records.map(rec => ({
    id: rec.get("id"),
    handle: rec.get("handle"),
    title: rec.get("title"),
    product_type: rec.get("productType"),
    vendor: rec.get("vendor"),
    images: (rec.get("images") || []).map(src => ({ src })),
    currentHero: rec.get("currentHero"),
  }));
}

async function updateHero(driver, productId, hero) {
  // Each write gets its own short-lived session — concurrent writes on the
  // same session aren't allowed by neo4j-driver.
  const s = driver.session();
  try {
    await s.run(
      `MATCH (p:Product {id: $id})
       SET p.heroImage = $heroImage,
           p.heroImageIndex = $heroImageIndex,
           p.heroImageSource = $heroImageSource,
           p.heroImageDecidedAt = $heroImageDecidedAt`,
      {
        id: productId,
        heroImage: hero.heroImage,
        heroImageIndex: hero.index,
        heroImageSource: hero.source,
        heroImageDecidedAt: new Date().toISOString(),
      }
    );
  } finally {
    await s.close();
  }
}

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Bronze Snake — hero image backfill`);
  console.log(`  Mode:        ${DRY_RUN ? "DRY-RUN (no Neo4j writes)" : "LIVE (writes to Neo4j)"}`);
  console.log(`  Force:       ${FORCE ? "YES (overwrite existing)" : "no (skip products that have a heroImage)"}`);
  console.log(`  Max:         ${MAX || "no limit"}`);
  console.log(`  Collection:  ${ONLY_COLLECTION || "any"}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`══════════════════════════════════════════════════════════\n`);

  const session = driver.session();
  let pickerProvider;
  try {
    const products = await fetchProducts(session);
    console.log(`Found ${products.length} eligible products in Neo4j\n`);
    if (products.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Use the real ShopifyProvider so the picker logic stays consistent with
    // the live sync. We don't need a real access token for this — picker only
    // reads images from the URLs we already have.
    pickerProvider = new ShopifyProvider({
      shopName: SHOP,
      accessToken: "noop-not-used-for-picker",
      region: "us-east-1",
    });

    const results = { gemini: 0, fallbackFirst: 0, onlyImage: 0, noImages: 0, lowConfidence: 0, errors: 0 };
    const startMs = Date.now();

    await mapWithConcurrency(products, CONCURRENCY, async (p, i, total) => {
      try {
        const hero = await pickerProvider.pickHeroImage(p);
        if (!hero?.heroImage) {
          results.noImages++;
          return;
        }
        results[hero.source === "gemini" ? "gemini" : hero.source === "only-image" ? "onlyImage" : "fallbackFirst"]++;
        if (hero.source === "fallback-first" && hero.confidence !== undefined) results.lowConfidence++;

        const eta = Math.round(((Date.now() - startMs) / (i + 1)) * (total - i - 1) / 1000);
        process.stdout.write(`  ${i + 1}/${total}  ETA ${eta}s  ${p.handle.padEnd(50).slice(0, 50)}  → [${hero.index}] ${hero.source}\n`);

        if (!DRY_RUN) {
          await updateHero(driver, p.id, hero);
        }
      } catch (e) {
        results.errors++;
        console.error(`  ERR  ${p.handle}: ${e.message}`);
      }
    });

    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`  Summary`);
    console.log(`══════════════════════════════════════════════════════════`);
    console.log(`  Gemini-picked:        ${results.gemini}`);
    console.log(`  Fallback to first:    ${results.fallbackFirst}  (incl. ${results.lowConfidence} low-confidence)`);
    console.log(`  Only one image:       ${results.onlyImage}`);
    console.log(`  No images:            ${results.noImages}`);
    console.log(`  Errors:               ${results.errors}`);
    console.log(`  Total processed:      ${products.length}`);
    console.log(`  Elapsed:              ${Math.round((Date.now() - startMs) / 1000)}s`);
    if (DRY_RUN) console.log(`\n  (dry-run — nothing was written to Neo4j)`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error("\nError:", e.message);
  console.error(e.stack);
  process.exit(1);
});
