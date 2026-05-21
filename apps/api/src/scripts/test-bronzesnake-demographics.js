#!/usr/bin/env node

/**
 * Bronze Snake — Sync Dry Run (READ-ONLY)
 *
 * Instantiates the real ShopifyProvider with the new code (Option B query
 * filter + Bronze Snake demographic detection) and pulls a sample of products
 * straight through `transformGraphQLResponse`. Reports the demographic
 * distribution and prints examples — but does NOT touch Shopify, Neo4j,
 * DynamoDB, or PubNub.
 *
 * Usage:
 *   node apps/api/src/scripts/test-bronzesnake-demographics.js \
 *     bronze-snake-1.myshopify.com shpat_xxxx [--sample 200]
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { ShopifyProvider } from "../sync/providers/shopify.js";

const SHOP_DOMAIN = process.argv[2] || "bronze-snake-1.myshopify.com";
const ACCESS_TOKEN = process.argv[3];
const sampleIdx = process.argv.indexOf("--sample");
const SAMPLE = sampleIdx !== -1 ? parseInt(process.argv[sampleIdx + 1], 10) : 200;
const SHOW_EXAMPLES = 6;

if (!ACCESS_TOKEN) {
  console.error("Missing access token. Usage: node test-bronzesnake-demographics.js <shop> <token> [--sample N]");
  process.exit(1);
}

async function main() {
  console.log(`\n  Bronze Snake — sync dry run (READ-ONLY)`);
  console.log(`  Shop:        ${SHOP_DOMAIN}`);
  console.log(`  Token:       ${ACCESS_TOKEN.slice(0, 10)}...${ACCESS_TOKEN.slice(-4)}`);
  console.log(`  Sample size: ${SAMPLE}`);

  const provider = new ShopifyProvider({
    shopName: SHOP_DOMAIN,
    accessToken: ACCESS_TOKEN,
    region: "us-east-1",
    forceAll: false,
    demographic: "woman",
  });

  console.log(`  Query filter: "${provider.productQueryFilter}"\n`);

  // Pull pages through the actual provider until we have SAMPLE products
  const products = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext && products.length < SAMPLE) {
    const limit = Math.min(50, SAMPLE - products.length);
    const { products: batch, nextCursor, hasNextPage } = await provider.fetchProducts({ cursor, limit });
    products.push(...batch);
    cursor = nextCursor;
    hasNext = hasNextPage;
    process.stdout.write(`  fetched ${products.length}\r`);
  }
  console.log(`  ✓ Fetched ${products.length} products via ShopifyProvider.fetchProducts\n`);

  // Buckets from the demographics array each product carries
  const onlyMan = [];
  const onlyWoman = [];
  const dual = [];
  const noDemographics = [];
  for (const p of products) {
    const d = p.detectedDemographics;
    if (!d || d.length === 0) noDemographics.push(p);
    else if (d.includes("man") && d.includes("woman")) dual.push(p);
    else if (d.includes("man")) onlyMan.push(p);
    else if (d.includes("woman")) onlyWoman.push(p);
    else noDemographics.push(p);
  }

  // ─── Distribution ─────────────────────────────────────────────────────
  console.log("══════════════ DEMOGRAPHIC DISTRIBUTION ══════════════");
  const total = products.length;
  const fmt = (n) => `${String(n).padStart(4)}  (${((n / total) * 100).toFixed(1)}%)`;
  console.log(`  only-man          ${fmt(onlyMan.length)}`);
  console.log(`  only-woman        ${fmt(onlyWoman.length)}`);
  console.log(`  both man+woman    ${fmt(dual.length)}   ← saved twice (man AND woman edges)`);
  console.log(`  no-demographics   ${fmt(noDemographics.length)}`);

  // What a query filter would return
  console.log(`\n══════════════ QUERY-TIME RESULT SIZES ══════════════`);
  console.log(`  WHERE Demographic.name = "man"    → ${onlyMan.length + dual.length} products  (= only-man + dual)`);
  console.log(`  WHERE Demographic.name = "woman"  → ${onlyWoman.length + dual.length} products  (= only-woman + dual)`);

  // ─── Examples per bucket ──────────────────────────────────────────────
  const printSamples = (label, list) => {
    if (!list.length) return;
    console.log(`\n══════════════ ${label} — ${Math.min(SHOW_EXAMPLES, list.length)} examples ══════════════`);
    for (const p of list.slice(0, SHOW_EXAMPLES)) {
      const handles = p.collections.map(c => c.handle).join(", ") || "(none)";
      console.log(`  • ${p.title}`);
      console.log(`      product_type:        ${p.product_type || "(empty)"}`);
      console.log(`      tags:                ${p.tags || "(none)"}`);
      console.log(`      collections:         ${handles}`);
      console.log(`      detectedDemographics: [${p.detectedDemographics.join(", ")}]`);
    }
  };

  printSamples("ONLY MAN", onlyMan);
  printSamples("ONLY WOMAN", onlyWoman);
  printSamples("BOTH MAN+WOMAN (formerly 'unisex')", dual);
  if (noDemographics.length) printSamples("NO-DEMOGRAPHICS (problem!)", noDemographics);

  console.log(`\n  Done. (Read-only. Nothing was written to Shopify, Neo4j, DynamoDB, or PubNub.)\n`);
}

main().catch(e => {
  console.error("Error:", e.message);
  console.error(e.stack);
  process.exit(1);
});
