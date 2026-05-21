#!/usr/bin/env node

/**
 * TMP: wipe all CacheTable entries for bronze-snake-1.myshopify.com.
 *
 * Queries the `storeId-index` GSI on CacheTable for storeId =
 * bronze-snake-1.myshopify.com and deletes every matched item by its
 * primary key (`id`).
 *
 * Default is DRY RUN. Pass --confirm to actually delete.
 *
 * Usage:
 *   node apps/api/src/scripts/_tmp-clear-bronzesnake-cache.js              # dry run
 *   node apps/api/src/scripts/_tmp-clear-bronzesnake-cache.js --confirm    # delete
 *   node apps/api/src/scripts/_tmp-clear-bronzesnake-cache.js --storeId other.myshopify.com --confirm
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import AWS from "aws-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { AWS_REGION } from "../sync/services/config.js";

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const STORE_ID = argVal("storeId") || "bronze-snake-1.myshopify.com";
const CONFIRM = args.includes("--confirm");
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const STOREID_GSI = "storeId-index";
const CONCURRENCY = 16;

AWS.config.update({ region: AWS_REGION });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

async function collectIds() {
  const ids = [];
  let lastKey;
  let pages = 0;

  do {
    const params = {
      TableName: CACHE_TABLE,
      IndexName: STOREID_GSI,
      KeyConditionExpression: "storeId = :s",
      ExpressionAttributeValues: { ":s": STORE_ID },
      ProjectionExpression: "id",
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const res = await docClient.query(params).promise();
    for (const item of res.Items || []) {
      if (item?.id) ids.push(item.id);
    }
    lastKey = res.LastEvaluatedKey;
    pages++;
    process.stdout.write(`\r  Scanned ${pages} page(s), found ${ids.length} items`);
  } while (lastKey);

  process.stdout.write("\n");
  return ids;
}

async function deleteIds(ids) {
  let deleted = 0;
  let failed = 0;
  const failures = [];
  let cursor = 0;
  let lastTick = Date.now();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const my = cursor++;
        if (my >= ids.length) return;
        const id = ids[my];
        try {
          await docClient
            .delete({ TableName: CACHE_TABLE, Key: { id } })
            .promise();
          deleted++;
        } catch (e) {
          failed++;
          failures.push({ id, error: e.message });
        }
        if (Date.now() - lastTick > 500) {
          lastTick = Date.now();
          process.stdout.write(
            `\r  Deleted ${deleted}/${ids.length} (failed: ${failed})`,
          );
        }
      }
    }),
  );

  process.stdout.write(
    `\r  Deleted ${deleted}/${ids.length} (failed: ${failed})\n`,
  );
  return { deleted, failed, failures };
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  TMP: Clear CacheTable for store`);
  console.log(`  Store:  ${STORE_ID}`);
  console.log(`  Table:  ${CACHE_TABLE}`);
  console.log(`  Index:  ${STOREID_GSI}`);
  console.log(`  Mode:   ${CONFIRM ? "LIVE DELETE" : "DRY RUN (pass --confirm to delete)"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log("Collecting cache entry ids...");
  const ids = await collectIds();

  if (ids.length === 0) {
    console.log("\nNo cache entries found. Nothing to do.");
    return;
  }

  console.log(`\nFound ${ids.length} cache entries.`);
  console.log("Sample ids:");
  for (const id of ids.slice(0, 10)) console.log(`  • ${id}`);
  if (ids.length > 10) console.log(`  …and ${ids.length - 10} more`);

  if (!CONFIRM) {
    console.log(`\nDRY RUN — would delete ${ids.length} entries.`);
    console.log(`Re-run with --confirm to actually delete.\n`);
    return;
  }

  console.log(`\nDeleting ${ids.length} entries (concurrency=${CONCURRENCY})...`);
  const { deleted, failed, failures } = await deleteIds(ids);

  console.log(`\n──────────────────────────────────────────────────`);
  console.log(`Deleted: ${deleted}/${ids.length}`);
  if (failed > 0) {
    console.log(`Failed:  ${failed}`);
    failures.slice(0, 10).forEach((f) => console.log(`  ✗ ${f.id}: ${f.error}`));
    if (failures.length > 10) console.log(`  …and ${failures.length - 10} more failures`);
  }
  console.log(`──────────────────────────────────────────────────\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFatal:", e);
    process.exit(1);
  });
