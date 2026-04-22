#!/usr/bin/env node

/**
 * Backfill Toff SEO (Title + MetaTagDescription)
 *
 * Scans Neo4j for Toff products that do NOT yet have `seoTitle` populated,
 * generates SEO using the TOFF rules via Gemini (`generateSEO`), and saves
 * the result back into the Neo4j Product node (seoTitle + seoMetaDescription
 * + seoSource).
 *
 * This script only populates Neo4j — it does NOT push to VTEX. After running
 * this, run `sync-toff-seo.js` (default safe, skips products with existing
 * Title in VTEX) to push the new SEO to VTEX.
 *
 * Because `sync-toff-seo.js` by default skips products with non-empty `Title`
 * in VTEX, any manually-set SEO by the TOFF team is preserved automatically.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-toff-seo.js [--dry-run] [--limit N] [--handle <handle-or-url>] [--concurrency N]
 *
 * Options:
 *   --dry-run                 Generate SEO but do NOT save to Neo4j
 *   --limit <N>               Process at most N products (useful for staged rollout)
 *   --handle <handle-or-url>  Process a single product by handle or toff.ro URL
 *   --concurrency <N>         Parallel workers (default: 5). Higher = faster, mind Gemini quota.
 *   --force                   Also process products that already have seoTitle (regenerate)
 *
 * Examples:
 *   node apps/api/src/scripts/backfill-toff-seo.js --dry-run --limit 5
 *   node apps/api/src/scripts/backfill-toff-seo.js --limit 100 --concurrency 5
 *   node apps/api/src/scripts/backfill-toff-seo.js --handle acne-studios-rochie-camasa-cu-esarfa-aplicata-a20937-dlc
 *   node apps/api/src/scripts/backfill-toff-seo.js --concurrency 10           # full run
 *
 * Workflow:
 *   1. node backfill-toff-seo.js           → populates Neo4j
 *   2. node sync-toff-seo.js --dry-run     → preview what would be pushed to VTEX
 *   3. node sync-toff-seo.js               → push to VTEX (skips existing Title safely)
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";
import { generateSEO } from "../sync/services/ai-product-description.js";
import { mapWithConcurrency } from "../sync/utils/index.js";

// ─── Toff defaults ───────────────────────────────────────────────────

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const STORE_ID = `${accountName}.vtexcommercestable.com.br`;

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const concurrencyIdx = args.indexOf("--concurrency");
const concurrency = concurrencyIdx !== -1 ? Math.max(1, parseInt(args[concurrencyIdx + 1], 10) || 1) : 5;
const handleIdx = args.indexOf("--handle");
let singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;
if (singleHandle) {
  const urlMatch = singleHandle.match(/toff\.ro\/([^/]+)\/p/);
  if (urlMatch) singleHandle = urlMatch[1];
}

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getProductsMissingSEO({ limit, handle, force }) {
  const driver = getDriver();
  const session = driver.session();
  try {
    if (handle) {
      const r = await session.run(
        `MATCH (p:Product)
         WHERE p.storeId = $storeId AND p.handle = $handle
         RETURN p.id AS id, p.title AS title, p.handle AS handle,
                p.vendor AS vendor, p.category AS category, p.product AS product_type,
                p.description AS description, p.seoTitle AS seoTitle,
                [(p)-[:HAS_DEMOGRAPHIC]->(d:Demographic) | d.name] AS demographics,
                [(p)-[:HAS_CATEGORY]->(c:Category) | c.name] AS categories`,
        { storeId: STORE_ID, handle }
      );
      return r.records.map(mapRecord);
    }

    const missingClause = force
      ? "" // process all
      : "AND (p.seoTitle IS NULL OR trim(p.seoTitle) = '')";

    const limitClause = limit ? `LIMIT ${limit}` : "";
    const r = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         ${missingClause}
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.vendor AS vendor, p.category AS category, p.product AS product_type,
              p.description AS description, p.seoTitle AS seoTitle,
              [(p)-[:HAS_DEMOGRAPHIC]->(d:Demographic) | d.name] AS demographics,
              [(p)-[:HAS_CATEGORY]->(c:Category) | c.name] AS categories
       ORDER BY p.title
       ${limitClause}`,
      { storeId: STORE_ID }
    );
    return r.records.map(mapRecord);
  } finally {
    await session.close();
    await driver.close();
  }
}

function mapRecord(rec) {
  return {
    id: rec.get("id"),
    title: rec.get("title"),
    handle: rec.get("handle"),
    vendor: rec.get("vendor"),
    category: rec.get("category"),
    product_type: rec.get("product_type"),
    description: rec.get("description"),
    seoTitle: rec.get("seoTitle"),
    demographics: rec.get("demographics") || [],
    categories: rec.get("categories") || [],
  };
}

async function saveSEOToNeo4j(driver, productId, seoTitle, seoMetaDescription, seoSource) {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (p:Product {id: $id, storeId: $storeId})
       SET p.seoTitle = $seoTitle,
           p.seoMetaDescription = $seoMetaDescription,
           p.seoSource = $seoSource,
           p.updated_at = $now`,
      {
        id: String(productId),
        storeId: STORE_ID,
        seoTitle,
        seoMetaDescription,
        seoSource,
        now: new Date().toISOString(),
      }
    );
  } finally {
    await session.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Backfill Toff SEO (Title + MetaTagDescription in Neo4j)`);
  console.log(`  Store:        ${STORE_ID}`);
  console.log(`  Mode:         ${dryRun ? "DRY RUN (no writes to Neo4j)" : "LIVE (writes to Neo4j)"}`);
  console.log(`  Filter:       ${force ? "ALL products (--force)" : "only products with seoTitle IS NULL"}`);
  console.log(`  Concurrency:  ${concurrency} worker(s)`);
  if (limit) console.log(`  Limit:        ${limit} products`);
  if (singleHandle) console.log(`  Handle:       ${singleHandle}`);
  console.log(`  Note:         this script does NOT push to VTEX. Run sync-toff-seo.js afterwards.`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Fetching products from Neo4j...`);
  const products = await getProductsMissingSEO({ limit, handle: singleHandle, force });
  console.log(`    Found ${products.length} products to backfill\n`);

  if (products.length === 0) {
    console.log("Nothing to do — all products already have seoTitle set.");
    return;
  }

  const sharedDriver = getDriver();
  const stats = { checked: 0, generated: 0, savedNeo4j: 0, skipped: 0, errors: 0, gemFailed: 0 };
  const startedAt = Date.now();

  try {
    await mapWithConcurrency(products, concurrency, async (p, i, total) => {
      stats.checked++;
      const tag = `[${String(stats.checked).padStart(String(total).length)}/${total}]`;

      try {
        if (!force && p.seoTitle && p.seoTitle.trim().length > 0) {
          console.log(`${tag} ✗ "${p.title}" — already has seoTitle, skipping (use --force to regenerate)`);
          stats.skipped++;
          return;
        }

        console.log(`${tag} ⏳ "${p.title}" (id: ${p.id})`);

        const seoInput = {
          title: p.title,
          vendor: p.vendor,
          product_type: p.product_type || p.category,
          categories: p.categories,
          demographics: p.demographics,
          description: p.description || "",
        };

        const seoResult = await generateSEO(seoInput, { language: "ro" });

        if (!seoResult || !seoResult.title || !seoResult.metaDescription) {
          console.log(`${tag} ✗ "${p.title}" — Gemini returned empty SEO`);
          stats.gemFailed++;
          return;
        }

        stats.generated++;

        if (dryRun) {
          console.log(`${tag} ✓ "${p.title}" — generated (title ${seoResult.title.length}ch, meta ${seoResult.metaDescription.length}ch) [DRY RUN]`);
          return;
        }

        await saveSEOToNeo4j(sharedDriver, p.id, seoResult.title, seoResult.metaDescription, seoResult.source);
        stats.savedNeo4j++;
        console.log(`${tag} ✓ "${p.title}" — saved (title ${seoResult.title.length}ch, meta ${seoResult.metaDescription.length}ch)`);
      } catch (err) {
        console.error(`${tag} ✗ "${p.title}" — ERROR: ${err.message}`);
        stats.errors++;
      }
    });
  } finally {
    await sharedDriver.close();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const avgPerProduct = products.length > 0 ? (parseFloat(elapsed) / products.length).toFixed(1) : "0";

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Checked:                ${stats.checked}`);
  console.log(`    Generated by Gemini:    ${stats.generated}`);
  console.log(`    Saved to Neo4j:         ${stats.savedNeo4j}`);
  console.log(`    Skipped (had seoTitle): ${stats.skipped}`);
  console.log(`    Gemini failures:        ${stats.gemFailed}`);
  console.log(`    Errors:                 ${stats.errors}`);
  console.log(`    Elapsed:                ${elapsed}s (${avgPerProduct}s/product avg, concurrency ${concurrency})`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  if (!dryRun && stats.savedNeo4j > 0) {
    console.log(`Next step: push the new SEO to VTEX with`);
    console.log(`  node apps/api/src/scripts/sync-toff-seo.js --dry-run      # preview`);
    console.log(`  node apps/api/src/scripts/sync-toff-seo.js                # push (skips products with existing Title in VTEX)\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
