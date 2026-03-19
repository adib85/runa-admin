#!/usr/bin/env node

/**
 * Cleanup Stale Products
 * Removes products from Neo4j that are no longer active in the e-commerce platform.
 * 
 * Compares each product's `lastSeenAt` timestamp against the latest sync timestamp
 * for the store. Products with an older `lastSeenAt` were not seen during the most
 * recent sync and are considered stale.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-cleanup-stale.js <storeId>
 *
 *   Options:
 *     --dry-run    Show what would be deleted without actually deleting
 *
 *   Examples:
 *     node apps/api/src/scripts/sync-cleanup-stale.js k8xbf0-5t.myshopify.com
 *     node apps/api/src/scripts/sync-cleanup-stale.js k8xbf0-5t.myshopify.com --dry-run
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const storeId = args.find(a => !a.startsWith("--"));

  if (!storeId) {
    console.error("Usage: node sync-cleanup-stale.js <storeId> [--dry-run]");
    process.exit(1);
  }

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();

  try {
    console.log(`\n── Stale product cleanup for ${storeId} ${dryRun ? "(DRY RUN)" : ""} ──\n`);

    // Find the latest lastSeenAt for this store
    const latestResult = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE p.lastSeenAt IS NOT NULL
       RETURN max(p.lastSeenAt) AS latestSync, count(p) AS totalWithTimestamp`,
      { storeId }
    );

    const record = latestResult.records[0];
    const latestSync = record?.get("latestSync");
    const totalWithTimestamp = record?.get("totalWithTimestamp");
    const total = totalWithTimestamp?.toNumber ? totalWithTimestamp.toNumber() : Number(totalWithTimestamp || 0);

    if (!latestSync) {
      console.log("  No products with lastSeenAt found. Run a sync first.");
      return;
    }

    console.log(`  Latest sync timestamp: ${latestSync}`);
    console.log(`  Products with lastSeenAt: ${total}`);

    // Find stale products
    const staleResult = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE (p.lastSeenAt IS NOT NULL AND p.lastSeenAt < $latestSync)
          OR (p.lastSeenAt IS NULL)
       RETURN p.id AS id, p.title AS title, p.lastSeenAt AS lastSeenAt
       ORDER BY p.lastSeenAt ASC`,
      { storeId, latestSync }
    );

    const staleProducts = staleResult.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      lastSeenAt: r.get("lastSeenAt")
    }));

    if (staleProducts.length === 0) {
      console.log("\n  ✓ No stale products found\n");
      return;
    }

    console.log(`\n  Found ${staleProducts.length} stale product(s):\n`);
    staleProducts.forEach(p => {
      const seen = p.lastSeenAt || "never";
      console.log(`    - [${p.id}] ${p.title} (lastSeenAt: ${seen})`);
    });

    if (dryRun) {
      console.log(`\n  DRY RUN — no products were deleted.\n`);
      return;
    }

    // Delete stale products
    await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE (p.lastSeenAt IS NOT NULL AND p.lastSeenAt < $latestSync)
          OR (p.lastSeenAt IS NULL)
       DETACH DELETE p`,
      { storeId, latestSync }
    );

    console.log(`\n  ✓ Deleted ${staleProducts.length} stale product(s)`);

    // Cleanup orphaned variants
    const orphanResult = await session.run(
      `MATCH (v:Variant) WHERE NOT (v)<-[:HAS_VARIANT]-(:Product)
       RETURN count(v) AS cnt`
    );
    const orphanCount = orphanResult.records[0]?.get("cnt");
    const orphans = orphanCount?.toNumber ? orphanCount.toNumber() : Number(orphanCount || 0);

    if (orphans > 0) {
      await session.run(
        `MATCH (v:Variant) WHERE NOT (v)<-[:HAS_VARIANT]-(:Product)
         DELETE v`
      );
      console.log(`  ✓ Cleaned up ${orphans} orphaned variant(s)`);
    }

    console.log("");
  } catch (error) {
    console.error("Cleanup failed:", error);
    process.exit(1);
  } finally {
    await session.close();
    await driver.close();
  }
}

main();
