#!/usr/bin/env node

/**
 * Invalidate Cache Fan-Out
 *
 * Standalone CLI for the cache-fanout helper. Scans all CTL / Similar Products
 * cache entries for a store and deletes the ones that reference any of the
 * given product ids or handles.
 *
 * Usage:
 *   node apps/api/src/scripts/invalidate-cache-fanout.js \
 *     --storeId <id> [--ids 1,2,3] [--handles a,b,c] [--dry-run]
 *
 * Examples:
 *   # Sweep TOFF cache for any reference to product 25806 or its handle
 *   node apps/api/src/scripts/invalidate-cache-fanout.js \
 *     --storeId toffro.vtexcommercestable.com.br \
 *     --ids 25806 \
 *     --handles valentino-garavani-rochie-candy-couture-7b3vadt01mmd1k
 *
 *   # Dry run only
 *   node apps/api/src/scripts/invalidate-cache-fanout.js \
 *     --storeId toffro.vtexcommercestable.com.br --ids 25806 --dry-run
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import AWS from "aws-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { AWS_REGION } from "../sync/services/config.js";
import { deleteReferencingCacheEntries } from "./cache-fanout.js";

AWS.config.update({ region: AWS_REGION });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const STORE_ID = argVal("storeId");
const IDS = argVal("ids");
const HANDLES = argVal("handles");
const DRY_RUN = args.includes("--dry-run");

if (!STORE_ID) {
  console.error("Usage: invalidate-cache-fanout.js --storeId <id> [--ids 1,2,3] [--handles a,b,c] [--dry-run]");
  process.exit(1);
}

const productIds = IDS ? String(IDS).split(",").map(s => s.trim()).filter(Boolean) : [];
const handles = HANDLES ? String(HANDLES).split(",").map(s => s.trim()).filter(Boolean) : [];

if (productIds.length === 0 && handles.length === 0) {
  console.error("Provide at least --ids or --handles");
  process.exit(1);
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Cache Fan-Out Invalidation`);
  console.log(`  Store:        ${STORE_ID}`);
  console.log(`  Mode:         ${DRY_RUN ? "DRY RUN (no deletes)" : "LIVE"}`);
  console.log(`  Product IDs:  ${productIds.length ? productIds.join(", ") : "(none)"}`);
  console.log(`  Handles:      ${handles.length ? handles.join(", ") : "(none)"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`Scanning CacheTable for ${STORE_ID}...`);
  let lastTick = Date.now();
  const result = await deleteReferencingCacheEntries(docClient, {
    storeId: STORE_ID,
    productIds,
    handles,
    cacheTable: CACHE_TABLE,
    dryRun: DRY_RUN,
    onProgress: ({ scanned, matched }) => {
      if (Date.now() - lastTick > 1000) {
        lastTick = Date.now();
        process.stdout.write(`\r  Scanned ${scanned} entries, matched ${matched}`);
      }
    },
  });
  process.stdout.write(`\r  Scanned ${result.scanned} entries, matched ${result.matched}\n\n`);

  if (result.matches.length === 0) {
    console.log("No referencing cache entries found.");
    return;
  }

  console.log(`Matches (${result.matches.length}):`);
  for (const m of result.matches.slice(0, 50)) {
    console.log(`  • ${m.id}`);
    console.log(`      ↳ ${m.location}`);
  }
  if (result.matches.length > 50) {
    console.log(`  …and ${result.matches.length - 50} more`);
  }

  console.log(`\n──────────────────────────────────────────────────`);
  if (DRY_RUN) {
    console.log(`DRY RUN — would delete ${result.matched} entries.`);
  } else {
    console.log(`Deleted: ${result.deleted}/${result.matched}`);
    if (result.failed > 0) {
      console.log(`Failed:  ${result.failed}`);
      result.failures.slice(0, 10).forEach(f => console.log(`  ✗ ${f.id}: ${f.error}`));
    }
  }
  console.log(`──────────────────────────────────────────────────\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error("Fatal:", e); process.exit(1); });
