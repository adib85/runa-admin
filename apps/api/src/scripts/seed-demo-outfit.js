#!/usr/bin/env node

/**
 * Manually seed a curated set of outfits into the demo cache for a specific store.
 *
 * Usage:
 *   node apps/api/src/scripts/seed-demo-outfit.js <input-file> [--dry-run]
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { seedDemoCache } from "../services/demoSeed.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const inputPath = args.find((a) => !a.startsWith("--"));

  if (!inputPath) {
    console.error("Usage: node seed-demo-outfit.js <input-file> [--dry-run]");
    process.exit(1);
  }

  const rawText = fs.readFileSync(path.resolve(inputPath), "utf8");
  console.log(`Read ${rawText.length} chars from ${inputPath}\n`);

  let stepIdx = 0;
  const onStep = (msg) => console.log(`[${++stepIdx}] ${msg}`);

  const { payload, domain } = await seedDemoCache(rawText, { dryRun, onStep });

  console.log("\n=== PAYLOAD SUMMARY ===");
  console.log(`store: ${payload.store.name} (${payload.store.domain})`);
  console.log(`productCount: ${payload.productCount}, collectionCount: ${payload.collectionCount}`);
  for (const [i, o] of [payload.outfit, ...payload.alternativeOutfits].entries()) {
    console.log(`\n  Outfit ${i + 1} (${o.outfit_name}) — total $${o.total_price}`);
    console.log(`    ANCHOR: ${o.anchor.title}`);
    for (const it of o.items) console.log(`    ITEM:   ${it.title}`);
  }

  if (!dryRun) {
    console.log(`\nDone. Test with: GET /api/demo/analyze?url=${domain}`);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
