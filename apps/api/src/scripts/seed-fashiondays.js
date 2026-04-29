#!/usr/bin/env node

/**
 * Seed the Fashion Days demo cache directly into DynamoDB.
 *
 * Useful when the API server hasn't been redeployed with the new
 * /demo-manual Fashion Days bypass yet — this script bypasses the API
 * entirely and writes the cache row that /api/demo/analyze will read on
 * the next visit to demo.askruna.ai?url=https://www.fashiondays.ro/.
 *
 * Usage:
 *   node apps/api/src/scripts/seed-fashiondays.js               # uses ./FashionDays
 *   node apps/api/src/scripts/seed-fashiondays.js --dry-run     # preview only
 *   node apps/api/src/scripts/seed-fashiondays.js --file path/to/outfits.txt
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { seedDemoCache } from "../services/demoSeed.js";

function parseArgs(argv) {
  const args = { dryRun: false, file: path.resolve(__dirname, "FashionDays") };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--file") args.file = path.resolve(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node seed-fashiondays.js [--dry-run] [--file <path>]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const { dryRun, file } = parseArgs(process.argv);

  console.log(`Reading outfit URLs from: ${file}`);
  const raw = readFileSync(file, "utf8");

  const result = await seedDemoCache(raw, {
    dryRun,
    onStep: (msg) => console.log(`  → ${msg}`),
  });

  console.log("\n─── Summary ──────────────────────────────────────────────");
  console.log(`Domain:       ${result.domain}`);
  console.log(`Store name:   ${result.storeName}`);
  console.log(`Outfits:      ${1 + (result.payload.alternativeOutfits?.length || 0)}`);
  console.log(`Total items:  ${result.payload.productCount}`);
  console.log(`Currency:     ${result.payload.store.currency}`);
  console.log(`Cache key:    demo_${result.domain}`);
  console.log(dryRun ? "\nDRY RUN — nothing was saved." : "\nSaved to DynamoDB.");

  console.log("\nFirst outfit preview:");
  const o = result.payload.outfit;
  console.log(`  Anchor: ${o.anchor.title} — ${o.anchor.vendor} — ${o.anchor.price} ${result.payload.store.currency}`);
  for (const it of o.items) {
    console.log(`    · ${it.title} — ${it.vendor} — ${it.price} ${result.payload.store.currency}`);
  }

  console.log("\nNow visit:");
  console.log(`  https://demo.askruna.ai/?url=https://www.${result.domain}/`);
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
