#!/usr/bin/env node

/**
 * Fix Orphaned Products
 * 
 * Repairs products missing relationships (HAS_PRODUCT, HAS_DEMOGRAPHIC,
 * HAS_VARIANT, HAS_CATEGORY) caused by the UNWIND chain bug.
 * 
 * Phase 1: Diagnose — report how many products are missing each relationship
 * Phase 2: Fix HAS_PRODUCT — connect orphaned products to the Store
 * Phase 3: Fix HAS_DEMOGRAPHIC — infer from existing categories, fallback to "unisex"
 * Phase 4: Mark for re-sync — set need_update=true so next sync re-processes fully
 * 
 * Usage:
 *   node apps/api/src/scripts/fix-orphaned-products.js <store-id>
 *   node apps/api/src/scripts/fix-orphaned-products.js <store-id> --dry-run
 * 
 * Examples:
 *   node apps/api/src/scripts/fix-orphaned-products.js toffro.vtexcommercestable.com.br
 *   node apps/api/src/scripts/fix-orphaned-products.js toffro.vtexcommercestable.com.br --dry-run
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

async function main() {
  const args = process.argv.slice(2);
  const storeId = args.find(a => !a.startsWith('-'));
  const dryRun = args.includes('--dry-run');

  if (!storeId) {
    console.error("Usage: node fix-orphaned-products.js <store-id> [--dry-run]");
    console.error("Example: node fix-orphaned-products.js toffro.vtexcommercestable.com.br");
    process.exit(1);
  }

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();

  try {
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║  Fix Orphaned Products${dryRun ? ' (DRY RUN)' : ''}`.padEnd(60) + `║`);
    console.log(`║  Store: ${storeId}`.padEnd(60) + `║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝\n`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: Diagnose
    // ═══════════════════════════════════════════════════════════
    console.log("── Phase 1: Diagnosis ──\n");

    const diagResult = await session.run(`
      MATCH (p:Product)
      WHERE p.storeId = $storeId
      RETURN
        count(p) AS total,
        sum(CASE WHEN NOT (:Store)-[:HAS_PRODUCT]->(p) THEN 1 ELSE 0 END) AS missingHasProduct,
        sum(CASE WHEN NOT (p)-[:HAS_DEMOGRAPHIC]->(:Demographic) THEN 1 ELSE 0 END) AS missingHasDemographic,
        sum(CASE WHEN NOT (p)-[:HAS_VARIANT]->(:Variant) THEN 1 ELSE 0 END) AS missingHasVariant,
        sum(CASE WHEN NOT (p)-[:HAS_CATEGORY]->(:Category) THEN 1 ELSE 0 END) AS missingHasCategory
    `, { storeId });

    const diag = diagResult.records[0];
    const total = diag.get('total').toNumber();
    const missingStore = diag.get('missingHasProduct').toNumber();
    const missingDemo = diag.get('missingHasDemographic').toNumber();
    const missingVariant = diag.get('missingHasVariant').toNumber();
    const missingCategory = diag.get('missingHasCategory').toNumber();

    console.log(`  Total products:          ${total}`);
    console.log(`  Missing HAS_PRODUCT:     ${missingStore}`);
    console.log(`  Missing HAS_DEMOGRAPHIC: ${missingDemo}`);
    console.log(`  Missing HAS_VARIANT:     ${missingVariant}`);
    console.log(`  Missing HAS_CATEGORY:    ${missingCategory}`);

    if (missingStore === 0 && missingDemo === 0 && missingVariant === 0 && missingCategory === 0) {
      console.log("\n  ✓ No orphaned products found. Everything looks good!\n");
      return;
    }

    if (dryRun) {
      console.log("\n  [DRY RUN] No changes made. Remove --dry-run to apply fixes.\n");
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Fix HAS_PRODUCT
    // ═══════════════════════════════════════════════════════════
    if (missingStore > 0) {
      console.log(`\n── Phase 2: Fixing ${missingStore} missing HAS_PRODUCT ──\n`);

      const fixResult = await session.run(`
        MATCH (p:Product)
        WHERE p.storeId = $storeId
        AND NOT (:Store)-[:HAS_PRODUCT]->(p)
        WITH p
        MATCH (store:Store {id: $storeId})
        MERGE (store)-[:HAS_PRODUCT]->(p)
        SET p.relationship_repaired_at = $now,
            p.needs_reindex = true
        RETURN count(p) AS fixed
      `, { storeId, now: new Date().toISOString() });

      console.log(`  ✓ Connected ${fixResult.records[0].get('fixed')} products to Store`);
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: Fix HAS_DEMOGRAPHIC (infer from existing categories)
    // ═══════════════════════════════════════════════════════════
    if (missingDemo > 0) {
      console.log(`\n── Phase 3: Fixing ${missingDemo} missing HAS_DEMOGRAPHIC ──\n`);

      // Try to infer demographic from existing HAS_CATEGORY relationships
      const inferResult = await session.run(`
        MATCH (p:Product)
        WHERE p.storeId = $storeId
        AND NOT (p)-[:HAS_DEMOGRAPHIC]->(:Demographic)
        OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category)
        WITH p, collect(DISTINCT toLower(c.name)) AS categories
        WITH p,
          CASE
            WHEN any(cat IN categories WHERE cat CONTAINS 'femei' OR cat CONTAINS 'women' OR cat CONTAINS 'woman') THEN 'woman'
            WHEN any(cat IN categories WHERE cat =~ '.*b[aă]rba[tț]i.*' OR cat CONTAINS 'men' OR cat CONTAINS 'man') THEN 'man'
            ELSE null
          END AS inferred
        WITH p, COALESCE(inferred, 'unisex') AS demographic
        MERGE (d:Demographic {name: demographic})
        MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)
        SET p.need_update = true,
            p.relationship_repaired_at = COALESCE(p.relationship_repaired_at, $now),
            p.needs_reindex = true
        RETURN demographic, count(p) AS cnt
        ORDER BY cnt DESC
      `, { storeId, now: new Date().toISOString() });

      let inferredCount = 0;
      let fallbackCount = 0;
      for (const record of inferResult.records) {
        const demo = record.get('demographic');
        const cnt = record.get('cnt').toNumber();
        const label = demo === 'unisex' ? '(could not infer — defaulted)' : '(inferred from categories)';
        console.log(`  ✓ ${cnt} products → "${demo}" ${label}`);
        if (demo === 'unisex') fallbackCount += cnt;
        else inferredCount += cnt;
      }

      if (fallbackCount > 0) {
        console.log(`\n  Note: ${fallbackCount} products defaulted to "unisex" because they had no`);
        console.log(`  category data to infer from. These are marked need_update=true and`);
        console.log(`  will get the real demographic on the next sync run.`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 4: Mark products with missing variants/categories for re-sync
    // ═══════════════════════════════════════════════════════════
    const needsResync = missingVariant + missingCategory;
    if (needsResync > 0) {
      console.log(`\n── Phase 4: Marking products for re-sync ──\n`);

      const markResult = await session.run(`
        MATCH (p:Product)
        WHERE p.storeId = $storeId
        AND (
          NOT (p)-[:HAS_VARIANT]->(:Variant)
          OR NOT (p)-[:HAS_CATEGORY]->(:Category)
        )
        SET p.need_update = true,
            p.relationship_repaired_at = COALESCE(p.relationship_repaired_at, $now),
            p.needs_reindex = true
        RETURN count(p) AS marked
      `, { storeId, now: new Date().toISOString() });

      const marked = markResult.records[0].get('marked').toNumber();
      console.log(`  ✓ Marked ${marked} products with need_update=true`);
      console.log(`    (missing variants: ${missingVariant}, missing categories: ${missingCategory})`);
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 5: Also mark all products that got a fallback demographic for re-sync
    // (they already have need_update from Phase 3, but ensure it for consistency)
    // ═══════════════════════════════════════════════════════════
    if (missingStore > 0) {
      await session.run(`
        MATCH (p:Product)
        WHERE p.storeId = $storeId
        AND p.need_update IS NULL
        AND NOT (p)-[:HAS_VARIANT]->(:Variant)
        SET p.need_update = true,
            p.relationship_repaired_at = COALESCE(p.relationship_repaired_at, $now),
            p.needs_reindex = true
      `, { storeId, now: new Date().toISOString() });
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    const totalFixed = missingStore + missingDemo + needsResync;
    console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
    console.log(`║  REPAIR COMPLETE                                              ║`);
    console.log(`╠═══════════════════════════════════════════════════════════════╣`);
    console.log(`║  Fixed HAS_PRODUCT:     ${String(missingStore).padEnd(38)}║`);
    console.log(`║  Fixed HAS_DEMOGRAPHIC: ${String(missingDemo).padEnd(38)}║`);
    console.log(`║  Marked for re-sync:    ${String(needsResync).padEnd(38)}║`);
    console.log(`║  Flagged (relationship_repaired_at): ${String(totalFixed).padEnd(31)}║`);
    console.log(`╠═══════════════════════════════════════════════════════════════╣`);
    console.log(`║  Next steps:                                                  ║`);
    console.log(`║  1. Run sync (without --force) to re-process marked products  ║`);
    console.log(`║  2. Re-run this script to verify all relationships exist      ║`);
    console.log(`║  3. Use this query to find products that need cache update:    ║`);
    console.log(`║                                                               ║`);
    console.log(`║  MATCH (p:Product)                                            ║`);
    console.log(`║  WHERE p.needs_reindex = true                                 ║`);
    console.log(`║  RETURN p.id, p.relationship_repaired_at                      ║`);
    console.log(`╚═══════════════════════════════════════════════════════════════╝\n`);

  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error("Fix failed:", e);
  process.exit(1);
});
