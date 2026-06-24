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
 *     --grace-days       Days a product must be UNSEEN before deletion (default: 14).
 *                        Rides out temporary sell-outs (a sold-out product drops out of
 *                        the in-stock fetch but isn't really gone). Use 0 for the legacy
 *                        "delete anything not in the latest sync" behavior.
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
import fetch from "node-fetch";

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

// Parse the handle of the OWNER product from a cache id.
// Cache id formats:
//   <storeId>_<handle>_<lang>                  → CTL cache (handle is the owner)
//   <storeId>_similar_products_<handle>_<lang> → Similar Products cache
//   <storeId>_userOptions_<handle>_<lang>      → user options cache
function parseOwnerHandleFromCacheId(cacheId, storeId) {
  if (!cacheId || !cacheId.startsWith(storeId + "_")) return null;
  let rest = cacheId.slice(storeId.length + 1);
  // Strip language suffix (last segment after final underscore, only if it looks like a lang code)
  const lastUnderscore = rest.lastIndexOf("_");
  if (lastUnderscore > 0) {
    const tail = rest.slice(lastUnderscore + 1);
    if (/^[a-z]{2}$/i.test(tail)) rest = rest.slice(0, lastUnderscore);
  }
  // Strip known prefixes
  for (const prefix of ["similar_products_", "userOptions_"]) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  return rest || null;
}

async function clearCacheTimestampsForHandles(driver, storeId, handles) {
  if (handles.length === 0) return 0;
  const session = driver.session();
  try {
    const result = await session.run(
      `UNWIND $handles AS h
       MATCH (p:Product {storeId: $storeId, handle: h})
       SET p.complete_the_look_updated_at = NULL,
           p.similar_product_updated_at = NULL,
           p.needs_reindex = true
       RETURN count(p) AS updated`,
      { storeId, handles }
    );
    return result.records[0]?.get("updated")?.toNumber?.() || 0;
  } finally {
    await session.close();
  }
}

async function deleteReferencingCacheEntries(docClient, driver, deletedHandles, storeId) {
  const deletedSet = new Set(deletedHandles);
  const ownersWithDeletedCache = new Set();
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
          // Track the OWNER product so we can clear its timestamp → cron will regenerate
          const ownerHandle = parseOwnerHandleFromCacheId(item.id, storeId);
          if (ownerHandle && !deletedSet.has(ownerHandle)) {
            ownersWithDeletedCache.add(ownerHandle);
          }
          console.log(`\n    ✗ Deleted cache: ${item.id} (references: ${h})`);
          break;
        }
      }
    }
  } while (lastEvaluatedKey);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ✓ Scanned ${scannedCount} cache entries in ${elapsed}s, deleted ${deletedCount} referencing entries`);

  // ── Clear timestamps so the next nightly cron with --missing reprocesses these ──
  if (ownersWithDeletedCache.size > 0 && driver) {
    const handles = [...ownersWithDeletedCache];
    console.log(`  Clearing widget timestamps on ${handles.length} affected product(s) so they get reprocessed...`);
    const updated = await clearCacheTimestampsForHandles(driver, storeId, handles);
    console.log(`  ✓ Marked ${updated} product(s) for re-indexing (needs_reindex=true, timestamps cleared)`);
  }

  return deletedCount;
}

// Partition stale candidates by storefront status. Only products whose product page
// returns a definite 404 are treated as "removed" (safe to delete). Anything else —
// 200 (still listed, e.g. sold out), a redirect/5xx, a timeout, or a missing handle —
// is KEPT. We never delete on uncertainty. Checked with bounded concurrency.
async function partitionByStorefront(candidates, host, concurrency = 10) {
  const removed = [];   // 404 → genuinely gone
  const kept = [];      // 200 → still listed (e.g. sold out)
  const unverifiable = []; // no handle / non-200-non-404 / network error → keep, but surface
  let idx = 0;

  async function worker() {
    while (idx < candidates.length) {
      const p = candidates[idx++];
      if (!p.handle) { unverifiable.push({ ...p, reason: "no handle" }); continue; }
      const url = `https://${host}/products/${encodeURIComponent(p.handle)}.json`;
      try {
        // redirect: "manual" so a handle that 301s to a new URL counts as "still exists" (kept),
        // not as a 404. AbortController gives us a hard timeout.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let r;
        try {
          r = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (r.status === 404) removed.push(p);
        else if (r.status === 200) kept.push(p);
        else unverifiable.push({ ...p, reason: `http ${r.status}` });
      } catch (e) {
        unverifiable.push({ ...p, reason: e.name === "AbortError" ? "timeout" : (e.message || "fetch error") });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { removed, kept, unverifiable };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const maxPctIdx = args.indexOf("--max-delete-pct");
  const maxDeletePct = maxPctIdx !== -1 ? parseInt(args[maxPctIdx + 1], 10) : 10;
  // Grace period: a product must be UNSEEN for this many consecutive days before it
  // is deleted. This rides out temporary sell-outs — on some shops (e.g. Bronze Snake)
  // the nightly fetch only indexes in-stock products visible on /collections/all, so a
  // sold-out item drops out of the fetch for a few days and would otherwise look "stale"
  // even though it's still published and will restock. Only genuinely-discontinued
  // products stay unseen long enough to age past the grace window. 0 = delete anything
  // not in the latest sync (legacy behavior). Default: 14 days.
  const graceIdx = args.indexOf("--grace-days");
  const graceDays = graceIdx !== -1 ? parseInt(args[graceIdx + 1], 10) : 14;
  // --require-404: before deleting, confirm each candidate is genuinely GONE from the
  // storefront (its /products/<handle>.json returns 404). Products that still resolve
  // (200) are kept — this is how we keep sold-out-but-still-listed items, which on some
  // shops (Bronze Snake) drop out of the in-stock fetch but are not actually removed.
  // Anything we can't positively confirm as 404 (200, 3xx/5xx, timeout, no handle) is
  // KEPT — we only ever delete on a definite 404. Opt-in, so other shops are unchanged.
  const require404 = args.includes("--require-404");
  const hostIdx = args.indexOf("--storefront-host");
  const storefrontHost = hostIdx !== -1 ? args[hostIdx + 1] : null;
  const valueFlags = new Set(["--max-delete-pct", "--grace-days", "--storefront-host"]);
  const storeId = args.find((a, i) => !a.startsWith("--") && (i === 0 || !valueFlags.has(args[i - 1])));

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

    // Cutoff = latest sync minus the grace period. A product is only "stale" if it
    // hasn't been seen since this cutoff (i.e. unseen for >= graceDays). Anchoring on
    // latestSync (not Date.now()) keeps the window correct even if cleanup runs a bit
    // after the sync. ISO-8601 UTC strings compare correctly lexicographically.
    const cutoff = new Date(new Date(latestSync).getTime() - graceDays * 24 * 60 * 60 * 1000).toISOString();

    console.log(`  Total products in store: ${totalAll}`);
    console.log(`  Products with lastSeenAt: ${total}`);
    console.log(`  Latest sync timestamp: ${latestSync}`);
    console.log(`  Grace period: ${graceDays} day(s) — delete only if unseen since ${cutoff}`);
    console.log(`  Safety threshold: ${maxDeletePct}% max deletion`);

    // Find stale products — unseen since the cutoff (older than the grace window),
    // or never stamped at all.
    const staleResult = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE (p.lastSeenAt IS NOT NULL AND p.lastSeenAt < $cutoff)
          OR (p.lastSeenAt IS NULL)
       RETURN p.id AS id, p.title AS title, p.handle AS handle, p.lastSeenAt AS lastSeenAt
       ORDER BY p.lastSeenAt ASC`,
      { storeId, cutoff }
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

    console.log(`\n  Found ${staleProducts.length} candidate(s) unseen since the grace cutoff:\n`);
    staleProducts.forEach(p => {
      const seen = p.lastSeenAt || "never";
      console.log(`    - [${p.id}] ${p.title} (lastSeenAt: ${seen})`);
    });

    // ── 404-gate (opt-in via --require-404) ─────────────────────────────────────
    // Confirm each candidate is genuinely GONE before deleting it. A product still
    // listed on the storefront (200) — e.g. sold out but not removed — is kept; only
    // a definite 404 is deleted. This is what lets sold-out items survive restocks.
    let toDelete = staleProducts;
    if (require404) {
      const host = storefrontHost || storeId;
      console.log(`\n  Verifying candidates against https://${host}/products/<handle>.json`);
      console.log(`  (404 = removed → delete · 200 = still listed → keep · anything else → keep)`);
      const { removed, kept, unverifiable } = await partitionByStorefront(staleProducts, host);
      console.log(`  → ${removed.length} removed (404), ${kept.length} still listed (200 — kept), ${unverifiable.length} unverifiable (kept)`);
      if (unverifiable.length > 0) {
        console.log(`    Unverifiable (kept, not deleted):`);
        unverifiable.slice(0, 20).forEach(p => console.log(`      - ${p.handle || p.id} (${p.reason})`));
        if (unverifiable.length > 20) console.log(`      …and ${unverifiable.length - 20} more`);
      }
      toDelete = removed;
    }

    if (toDelete.length === 0) {
      console.log(`\n  ✓ Nothing to delete${require404 ? " — no candidate is a confirmed storefront 404" : ""}\n`);
      return;
    }

    const deletePct = totalAll > 0 ? (toDelete.length / totalAll) * 100 : 0;
    console.log(`\n  Will delete ${toDelete.length} product(s) (${deletePct.toFixed(1)}% of ${totalAll} total).`);

    if (dryRun) {
      console.log(`\n  (Cache deletion is disabled — only the ${toDelete.length} Neo4j product node(s) + their orphaned variants would be removed; the CacheTable is not touched.)`);
      console.log(`\n  DRY RUN — nothing was deleted.\n`);
      return;
    }

    if (!force && deletePct > maxDeletePct) {
      console.error(`\n  ✗ ABORTED — would delete ${deletePct.toFixed(1)}% of products, which exceeds the ${maxDeletePct}% safety threshold.`);
      console.error(`    This usually means the previous sync failed or was incomplete.`);
      console.error(`    Run with --force to override, or --max-delete-pct <n> to adjust the threshold.\n`);
      process.exit(1);
    }

    // We delete by an explicit id list (the confirmed set) rather than re-running the
    // cutoff WHERE clause — so we delete EXACTLY what we listed/verified above, nothing
    // more. Still scoped to this store's products.
    const deleteIds = toDelete.map(p => p.id);

    // Collect the variant ids belonging to the products we're about to delete BEFORE we
    // delete them, so the orphan cleanup below can be scoped to exactly these ids and can
    // NEVER touch another store's variants. (A variant has no storeId of its own — its
    // only link to a store is through its product, which is gone once we delete it.)
    const staleVariantResult = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)-[:HAS_VARIANT]->(v:Variant)
       WHERE p.id IN $deleteIds
       RETURN collect(DISTINCT v.id) AS variantIds`,
      { storeId, deleteIds }
    );
    const staleVariantIds = staleVariantResult.records[0]?.get("variantIds") || [];

    // Delete the confirmed products by id (scoped to this store).
    await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
       WHERE p.id IN $deleteIds
       DETACH DELETE p`,
      { storeId, deleteIds }
    );

    console.log(`\n  ✓ Deleted ${toDelete.length} product(s)`);

    // ── DISABLED: DynamoDB cache deletion ──────────────────────────────────────
    // We intentionally do NOT delete any Complete-the-Look or Similar Products cache
    // here — not the deleted product's own widgets (deleteCacheForProduct) nor other
    // products' widgets that referenced it (deleteReferencingCacheEntries). Both helpers
    // are kept defined for reference but are NOT called; cache handling will be replaced
    // with a different mechanism later. This cleanup now ONLY removes the Neo4j Product
    // nodes (and their orphaned variants) — it never touches the CacheTable.
    //
    // const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
    // const handles = toDelete.filter(p => p.handle).map(p => p.handle);
    // if (handles.length > 0) {
    //   console.log(`\n  Deleting cache entries for ${handles.length} product(s)...`);
    //   let totalCacheDeleted = 0;
    //   for (const handle of handles) {
    //     const count = await deleteCacheForProduct(docClient, handle, storeId);
    //     if (count > 0) console.log(`    - ${handle}: ${count} cache entries`);
    //     totalCacheDeleted += count;
    //   }
    //   console.log(`  ✓ ${totalCacheDeleted} direct cache entries deleted`);
    //   await deleteReferencingCacheEntries(docClient, driver, handles, storeId);
    // }
    // ────────────────────────────────────────────────────────────────────────────

    // Cleanup orphaned variants — SCOPED to the variants that belonged to the
    // products we just deleted (collected above). We only delete a variant if it
    // is now truly parentless (no remaining product points at it), so a variant
    // whose id happens to be shared with a live product in another store is left
    // alone. This can never touch another store's variants.
    if (staleVariantIds.length > 0) {
      const orphanResult = await session.run(
        `MATCH (v:Variant)
         WHERE v.id IN $staleVariantIds AND NOT (v)<-[:HAS_VARIANT]-(:Product)
         RETURN count(v) AS cnt`,
        { staleVariantIds }
      );
      const orphanCount = orphanResult.records[0]?.get("cnt");
      const orphans = orphanCount?.toNumber ? orphanCount.toNumber() : Number(orphanCount || 0);

      if (orphans > 0) {
        await session.run(
          `MATCH (v:Variant)
           WHERE v.id IN $staleVariantIds AND NOT (v)<-[:HAS_VARIANT]-(:Product)
           DETACH DELETE v`,
          { staleVariantIds }
        );
        console.log(`  ✓ Cleaned up ${orphans} orphaned variant(s) (scoped to deleted products)`);
      }
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
