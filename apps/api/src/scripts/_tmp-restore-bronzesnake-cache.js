#!/usr/bin/env node

/**
 * TMP: copy bronze-snake cache items from a PITR-restored CacheTable
 * back into the live CacheTable — fast, streaming pipeline.
 *
 * Source table is expected to be a point-in-time restore of `CacheTable`
 * (same schema + `storeId-index` GSI). We Query that GSI for
 * storeId = bronze-snake-1.myshopify.com and stream items into a worker
 * pool that flushes them via BatchWriteItem (25 per call) into the live
 * `CacheTable`. Read and write run in parallel.
 *
 * BatchWriteItem does NOT support ConditionExpression, so by default
 * this OVERWRITES any items that may already exist live. If you need
 * the no-overwrite behaviour, pass --safe (uses PutItem with
 * attribute_not_exists; ~10x slower).
 *
 * Default is DRY RUN. Pass --confirm to actually write.
 *
 * Usage:
 *   node apps/api/src/scripts/_tmp-restore-bronzesnake-cache.js                          # dry run
 *   node apps/api/src/scripts/_tmp-restore-bronzesnake-cache.js --confirm                # fast (overwrite via BatchWriteItem)
 *   node apps/api/src/scripts/_tmp-restore-bronzesnake-cache.js --confirm --safe         # slow (PutItem + skip existing)
 *   node apps/api/src/scripts/_tmp-restore-bronzesnake-cache.js --src OtherSrc --dst CacheTable
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
const SRC_TABLE = argVal("src") || "CacheTable-restore-bronzesnake-20260509";
const DST_TABLE = argVal("dst") || process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const CONFIRM = args.includes("--confirm");
const SAFE = args.includes("--safe");
const STOREID_GSI = "storeId-index";
const WRITE_CONCURRENCY = 24;
const BATCH_SIZE = 25;
const QUEUE_HIGH_WATER = 2000;

AWS.config.update({ region: AWS_REGION });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Queue {
  constructor(highWater) {
    this.items = [];
    this.high = highWater;
    this.done = false;
    this.waiters = [];
    this.drainWaiters = [];
  }
  async push(item) {
    this.items.push(item);
    if (this.waiters.length) this.waiters.shift()();
    while (this.items.length >= this.high && !this.done) {
      await new Promise(r => this.drainWaiters.push(r));
    }
  }
  finish() {
    this.done = true;
    while (this.waiters.length) this.waiters.shift()();
  }
  async take(n) {
    while (this.items.length === 0 && !this.done) {
      await new Promise(r => this.waiters.push(r));
    }
    const out = this.items.splice(0, n);
    if (this.items.length < this.high && this.drainWaiters.length) {
      while (this.drainWaiters.length) this.drainWaiters.shift()();
    }
    return out;
  }
  isDone() { return this.done && this.items.length === 0; }
}

async function readerLoop(queue, stats) {
  let lastKey;
  do {
    const params = {
      TableName: SRC_TABLE,
      IndexName: STOREID_GSI,
      KeyConditionExpression: "storeId = :s",
      ExpressionAttributeValues: { ":s": STORE_ID },
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const res = await docClient.query(params).promise();
    for (const item of res.Items || []) {
      if (item?.id) {
        await queue.push(item);
        stats.read++;
      }
    }
    stats.pages++;
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  queue.finish();
}

async function batchWriteWithRetry(items) {
  let request = {
    RequestItems: {
      [DST_TABLE]: items.map(Item => ({ PutRequest: { Item } })),
    },
  };
  let attempt = 0;
  let written = items.length;
  let unprocessedCount = 0;
  while (request.RequestItems && Object.keys(request.RequestItems).length > 0) {
    const res = await docClient.batchWrite(request).promise();
    const unp = res.UnprocessedItems || {};
    if (!unp[DST_TABLE] || unp[DST_TABLE].length === 0) {
      unprocessedCount = 0;
      break;
    }
    unprocessedCount = unp[DST_TABLE].length;
    request = { RequestItems: unp };
    attempt++;
    const backoff = Math.min(2000, 50 * Math.pow(2, attempt));
    await sleep(backoff);
    if (attempt > 10) break;
  }
  return { written: written - unprocessedCount, unprocessed: unprocessedCount };
}

async function safePutWithRetry(item) {
  let attempt = 0;
  while (true) {
    try {
      await docClient.put({
        TableName: DST_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(id)",
      }).promise();
      return { written: 1, skipped: 0 };
    } catch (e) {
      if (e.code === "ConditionalCheckFailedException") return { written: 0, skipped: 1 };
      if (e.code === "ProvisionedThroughputExceededException" && attempt < 8) {
        attempt++;
        await sleep(Math.min(2000, 50 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
}

async function writerLoop(queue, stats, mode) {
  while (!queue.isDone() || queue.items.length > 0) {
    if (mode === "batch") {
      const batch = await queue.take(BATCH_SIZE);
      if (batch.length === 0) return;
      try {
        const r = await batchWriteWithRetry(batch);
        stats.written += r.written;
        stats.unprocessed += r.unprocessed;
      } catch (e) {
        stats.failed += batch.length;
        if (stats.failures.length < 20) {
          for (const it of batch) stats.failures.push({ id: it.id, error: e.message });
        }
      }
    } else {
      const [item] = await queue.take(1);
      if (!item) return;
      try {
        const r = await safePutWithRetry(item);
        stats.written += r.written;
        stats.skippedExisting += r.skipped;
      } catch (e) {
        stats.failed++;
        if (stats.failures.length < 20) stats.failures.push({ id: item.id, error: e.message });
      }
    }
  }
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  TMP: Restore CacheTable items from PITR backup`);
  console.log(`  Store:        ${STORE_ID}`);
  console.log(`  Source:       ${SRC_TABLE}`);
  console.log(`  Destination:  ${DST_TABLE}`);
  console.log(`  Index:        ${STOREID_GSI}`);
  console.log(`  Mode:         ${CONFIRM ? "LIVE WRITE" : "DRY RUN (pass --confirm to write)"}`);
  console.log(`  Strategy:     ${SAFE ? "PutItem + skip-if-exists (slow, safe)" : "BatchWriteItem (fast, OVERWRITES)"}`);
  console.log(`  Concurrency:  ${WRITE_CONCURRENCY} workers${SAFE ? "" : ` × ${BATCH_SIZE} items/batch`}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  if (!CONFIRM) {
    console.log("DRY RUN — counting items in source...");
    let lastKey, total = 0, pages = 0;
    do {
      const params = {
        TableName: SRC_TABLE,
        IndexName: STOREID_GSI,
        KeyConditionExpression: "storeId = :s",
        ExpressionAttributeValues: { ":s": STORE_ID },
        Select: "COUNT",
      };
      if (lastKey) params.ExclusiveStartKey = lastKey;
      try {
        const res = await docClient.query(params).promise();
        total += res.Count || 0;
        lastKey = res.LastEvaluatedKey;
        pages++;
        process.stdout.write(`\r  Pages ${pages}, count ${total}`);
      } catch (e) {
        if (e.code === "ResourceNotFoundException") {
          console.error(`\nSource table or index not found: ${e.message}`);
          process.exit(2);
        }
        throw e;
      }
    } while (lastKey);
    process.stdout.write("\n");
    console.log(`\nDRY RUN — would copy ${total} items from ${SRC_TABLE} → ${DST_TABLE}.`);
    console.log(`Re-run with --confirm to actually write.\n`);
    return;
  }

  const stats = { read: 0, written: 0, skippedExisting: 0, failed: 0, unprocessed: 0, pages: 0, failures: [] };
  const queue = new Queue(QUEUE_HIGH_WATER);
  const startedAt = Date.now();

  const reader = readerLoop(queue, stats).catch(e => { console.error("\nReader error:", e); throw e; });

  const writers = Array.from({ length: WRITE_CONCURRENCY }, () =>
    writerLoop(queue, stats, SAFE ? "safe" : "batch")
  );

  const ticker = setInterval(() => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const wps = stats.written > 0 ? (stats.written / Math.max(1, (Date.now() - startedAt) / 1000)).toFixed(1) : "0";
    process.stdout.write(
      `\r  [${elapsed}s] read=${stats.read} written=${stats.written} (${wps}/s) skipped=${stats.skippedExisting} failed=${stats.failed} queueDepth=${queue.items.length}`
    );
  }, 500);

  try {
    await reader;
    await Promise.all(writers);
  } finally {
    clearInterval(ticker);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write("\n");
  console.log(`\n──────────────────────────────────────────────────`);
  console.log(`Elapsed:           ${elapsed}s`);
  console.log(`Read:              ${stats.read} (${stats.pages} pages)`);
  console.log(`Written:           ${stats.written}`);
  if (SAFE) console.log(`Skipped existing:  ${stats.skippedExisting}`);
  if (stats.unprocessed > 0) console.log(`Unprocessed:       ${stats.unprocessed} (after retries)`);
  if (stats.failed > 0) {
    console.log(`Failed:            ${stats.failed}`);
    stats.failures.slice(0, 10).forEach(f => console.log(`  ✗ ${f.id}: ${f.error}`));
  }
  console.log(`──────────────────────────────────────────────────\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFatal:", e);
    process.exit(1);
  });
