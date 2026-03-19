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
 *     --dry-run          Show what would be deleted without actually deleting
 *     --max-delete-pct   Max % of products allowed to delete (default: 10). Aborts if exceeded.
 *     --force            Skip the safety threshold check
 *
 *   Examples:
 *     node apps/api/src/scripts/sync-cleanup-stale.js k8xbf0-5t.myshopify.com
 *     node apps/api/src/scripts/sync-cleanup-stale.js k8xbf0-5t.myshopify.com --dry-run
 *     node apps/api/src/scripts/sync-cleanup-stale.js k8xbf0-5t.myshopify.com --max-delete-pct 20
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import AWS from "aws-sdk";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

const AWS_REGION = "us-east-1";
const DYNAMODB_USER_TABLE = "UserTable";
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

async function getUserByShop(shop) {
  AWS.config.update({ region: AWS_REGION });
  const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
  const result = await docClient.query({
    TableName: DYNAMODB_USER_TABLE,
    IndexName: "shop_index",
    KeyConditionExpression: "#shop = :shop",
    ExpressionAttributeNames: { "#shop": "shop" },
    ExpressionAttributeValues: { ":shop": shop }
  }).promise();
  return result.Count > 0 ? result.Items[0] : null;
}

const COMMON_LANGUAGES = ["en", "ro"];
const CACHE_GSI = "storeId-index";

async function deleteCacheForProduct(docClient, handle, storeId) {
  const cacheKeys = COMMON_LANGUAGES.flatMap(lang => [
    `${storeId}_${handle}_${lang}`,
    `${storeId.toLowerCase()}_similar_products_${handle.toLowerCase()}_${lang}`
  ]);

  const results = await Promise.all(
    cacheKeys.map(id =>
      docClient.delete({ TableName: CACHE_TABLE, Key: { id }, ReturnValues: "ALL_OLD" })
        .promise()
        .then(res => res.Attributes ? 1 : 0)
        .catch(() => 0)
    )
  );
  return results.reduce((sum, v) => sum + v, 0);
}

function extractHandlesFromCacheData(data) {
  const handles = new Set();
  if (!data) return handles;

  // Similar products: only check data.products (the final curated list shown to users)
  (data.products || []).forEach(p => { if (p.handle) handles.add(p.handle); });

  // Complete the look: check data.outfits[].products_for_outfit (the final outfit shown to users)
  (data.outfits || []).forEach(outfit => {
    (outfit.products_for_outfit || []).forEach(p => { if (p.handle) handles.add(p.handle); });
  });

  return handles;
}

async function deleteReferencingCacheEntries(docClient, deletedHandles, storeId) {
  const deletedSet = new Set(deletedHandles);
  let scannedCount = 0;
  let deletedCount = 0;
  let lastEvaluatedKey = null;

  console.log(`\n  Scanning cache for entries referencing deleted products...`);
  const startTime = Date.now();

  do {
    const params = {
      TableName: CACHE_TABLE,
      IndexName: CACHE_GSI,
      KeyConditionExpression: "storeId = :storeId",
      ExpressionAttributeValues: { ":storeId": storeId },
    };
    if (lastEvaluatedKey) params.ExclusiveStartKey = lastEvaluatedKey;

    const result = await docClient.query(params).promise();
    lastEvaluatedKey = result.LastEvaluatedKey;
    scannedCount += result.Items.length;

    if (scannedCount % 1000 === 0 || !lastEvaluatedKey) {
      process.stdout.write(`\r    Scanned: ${scannedCount} cache entries...`);
    }

    for (const item of result.Items) {
      const referencedHandles = extractHandlesFromCacheData(item.data);
      for (const h of referencedHandles) {
        if (deletedSet.has(h)) {
          await docClient.delete({ TableName: CACHE_TABLE, Key: { id: item.id } }).promise().catch(() => {});
          deletedCount++;
          console.log(`\n    ✗ Deleted cache: ${item.id} (references: ${h})`);
          break;
        }
      }
    }
  } while (lastEvaluatedKey);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ✓ Scanned ${scannedCount} cache entries in ${elapsed}s, deleted ${deletedCount} referencing entries`);
  return deletedCount;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const maxPctIdx = args.indexOf("--max-delete-pct");
  const maxDeletePct = maxPctIdx !== -1 ? parseInt(args[maxPctIdx + 1], 10) : 10;
  const storeId = args.find((a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--max-delete-pct"));

  if (!storeId) {
    console.error("Usage: node sync-cleanup-stale.js <storeId> [--dry-run]");
    process.exit(1);
  }

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();

  try {
    console.log(`\n── Stale product cleanup for ${storeId} ${dryRun ? "(DRY RUN)" : ""} ──\n`);

    // Verify the last sync completed recently
    const user = await getUserByShop(storeId);
    const lastSyncCompletedAt = user?.lastSyncCompletedAt;

    if (!lastSyncCompletedAt) {
      console.log("  ✗ No lastSyncCompletedAt found in the store record. Run a full sync first.\n");
      process.exit(1);
    }

    const syncAgeHours = (Date.now() - new Date(lastSyncCompletedAt).getTime()) / (1000 * 60 * 60);
    console.log(`  Last sync completed: ${lastSyncCompletedAt} (${syncAgeHours.toFixed(1)}h ago)`);

    if (!force && syncAgeHours > 4) {
      console.error(`\n  ✗ ABORTED — last sync completed ${syncAgeHours.toFixed(1)}h ago (>4h).`);
      console.error(`    Cleanup should run immediately after a successful sync.`);
      console.error(`    Run with --force to override.\n`);
      process.exit(1);
    }

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

    // Total products for this store (with and without lastSeenAt)
    const totalResult = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       RETURN count(p) AS totalProducts`,
      { storeId }
    );
    const totalProducts = totalResult.records[0]?.get("totalProducts");
    const totalAll = totalProducts?.toNumber ? totalProducts.toNumber() : Number(totalProducts || 0);

    console.log(`  Total products in store: ${totalAll}`);
    console.log(`  Products with lastSeenAt: ${total}`);
    console.log(`  Latest sync timestamp: ${latestSync}`);
    console.log(`  Safety threshold: ${maxDeletePct}% max deletion`);

    // Find stale products
    const staleResult = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE (p.lastSeenAt IS NOT NULL AND p.lastSeenAt < $latestSync)
          OR (p.lastSeenAt IS NULL)
       RETURN p.id AS id, p.title AS title, p.handle AS handle, p.lastSeenAt AS lastSeenAt
       ORDER BY p.lastSeenAt ASC`,
      { storeId, latestSync }
    );

    const staleProducts = staleResult.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      lastSeenAt: r.get("lastSeenAt")
    }));

    if (staleProducts.length === 0) {
      console.log("\n  ✓ No stale products found\n");
      return;
    }

    const deletePct = totalAll > 0 ? (staleProducts.length / totalAll) * 100 : 0;

    console.log(`\n  Found ${staleProducts.length} stale product(s) (${deletePct.toFixed(1)}% of ${totalAll} total):\n`);
    staleProducts.forEach(p => {
      const seen = p.lastSeenAt || "never";
      console.log(`    - [${p.id}] ${p.title} (lastSeenAt: ${seen})`);
    });

    if (dryRun) {
      const handles = staleProducts.filter(p => p.handle).map(p => p.handle);
      const cacheEntries = handles.length * COMMON_LANGUAGES.length * 2;
      console.log(`\n  Cache entries that would be deleted: up to ${cacheEntries} (${handles.length} handles × ${COMMON_LANGUAGES.length} languages × 2 cache types)`);
      console.log(`\n  DRY RUN — no products or cache entries were deleted.\n`);
      return;
    }

    if (!force && deletePct > maxDeletePct) {
      console.error(`\n  ✗ ABORTED — would delete ${deletePct.toFixed(1)}% of products, which exceeds the ${maxDeletePct}% safety threshold.`);
      console.error(`    This usually means the previous sync failed or was incomplete.`);
      console.error(`    Run with --force to override, or --max-delete-pct <n> to adjust the threshold.\n`);
      process.exit(1);
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

    // Delete cache entries for stale products (all languages)
    const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
    const handles = staleProducts.filter(p => p.handle).map(p => p.handle);
    if (handles.length > 0) {
      console.log(`\n  Deleting cache entries for ${handles.length} product(s)...`);
      let totalCacheDeleted = 0;
      for (const handle of handles) {
        const count = await deleteCacheForProduct(docClient, handle, storeId);
        if (count > 0) console.log(`    - ${handle}: ${count} cache entries`);
        totalCacheDeleted += count;
      }
      console.log(`  ✓ ${totalCacheDeleted} direct cache entries deleted`);

      // Find and delete cache entries of OTHER products that reference deleted handles
      await deleteReferencingCacheEntries(docClient, handles, storeId);
    }

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
         DETACH DELETE v`
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
