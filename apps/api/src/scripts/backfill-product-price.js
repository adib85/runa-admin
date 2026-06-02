#!/usr/bin/env node

/**
 * Backfill `p.price` on Product nodes in Neo4j.
 *
 * The modular sync now populates `p.price = min(variant prices)` on every
 * Product node going forward. This script populates the same field for
 * products that were synced before the wiring landed.
 *
 * Source of truth is the existing `(:Product)-[:HAS_VARIANT]->(:Variant)`
 * data already in Neo4j — no Shopify round-trip needed. For each product
 * with at least one variant carrying a numeric price, sets
 *   p.price = min(toFloat(v.price))
 * Products with no variants, or no variant with a numeric price, are left
 * unchanged.
 *
 * Default is dry-run. Use --apply to write. Neo4j-only — never touches
 * Shopify. Works for any store; defaults to Bronze Snake.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-product-price.js
 *   node apps/api/src/scripts/backfill-product-price.js --apply
 *   node apps/api/src/scripts/backfill-product-price.js --shop other.myshopify.com --apply
 *   node apps/api/src/scripts/backfill-product-price.js --all --apply
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all");
const shopIdx = args.indexOf("--shop");
const SHOP = shopIdx !== -1 ? args[shopIdx + 1] : "bronze-snake-1.myshopify.com";

const n = (v) => (v && v.toNumber ? v.toNumber() : v);

async function main() {
  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
  );
  const session = driver.session();

  const scope = ALL ? "ALL stores" : `store="${SHOP}"`;
  console.log(`Mode:  ${APPLY ? "APPLY (will write to Neo4j)" : "DRY-RUN"}`);
  console.log(`Scope: ${scope}\n`);

  // Build the storeId predicate once so the same Cypher can target one shop
  // or every shop without rebuilding the query.
  const storeFilter = ALL ? "" : "AND p.storeId = $shop";

  try {
    // 1) Planning numbers — total products in scope, how many have a
    // numeric variant price, current p.price coverage.
    const plan = await session.run(
      `MATCH (p:Product)
       WHERE p.handle IS NOT NULL ${storeFilter}
       OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
       WITH p, min(CASE WHEN toFloat(v.price) IS NOT NULL THEN toFloat(v.price) ELSE null END) AS computed
       RETURN
         count(p) AS total,
         sum(CASE WHEN p.price IS NOT NULL THEN 1 ELSE 0 END) AS alreadyHavePrice,
         sum(CASE WHEN computed IS NOT NULL THEN 1 ELSE 0 END) AS canCompute,
         sum(CASE WHEN computed IS NULL THEN 1 ELSE 0 END) AS cannotCompute`,
      { shop: SHOP }
    );
    const r = plan.records[0];
    console.log(`Plan:`);
    console.log(`  Products in scope:                    ${n(r.get("total"))}`);
    console.log(`  Already have p.price set:             ${n(r.get("alreadyHavePrice"))}`);
    console.log(`  Have ≥1 variant with numeric price:   ${n(r.get("canCompute"))}`);
    console.log(`  No variant with numeric price (skip): ${n(r.get("cannotCompute"))}\n`);

    // 2) Sample what we would write
    const sample = await session.run(
      `MATCH (p:Product)-[:HAS_VARIANT]->(v:Variant)
       WHERE p.handle IS NOT NULL ${storeFilter}
       WITH p, min(toFloat(v.price)) AS computed
       WHERE computed IS NOT NULL
       RETURN p.storeId AS storeId, p.handle AS handle, p.price AS current, computed AS computed
       ORDER BY p.handle
       LIMIT 10`,
      { shop: SHOP }
    );
    console.log(`Sample (first 10):`);
    for (const rec of sample.records) {
      const cur = rec.get("current");
      const c = n(rec.get("computed"));
      console.log(`  ${rec.get("handle").padEnd(45)}  current=${cur === null ? "null" : cur}  → ${c}`);
    }
    console.log("");

    if (!APPLY) {
      console.log(`[DRY-RUN] Would set p.price on products with a computable min(variant price).`);
      console.log(`Run with --apply to commit.`);
      return;
    }

    // 3) Apply
    const writeRes = await session.executeWrite(tx => tx.run(
      `MATCH (p:Product)-[:HAS_VARIANT]->(v:Variant)
       WHERE p.handle IS NOT NULL ${storeFilter}
       WITH p, min(toFloat(v.price)) AS computed
       WHERE computed IS NOT NULL
       SET p.price = computed
       RETURN count(p) AS updated`,
      { shop: SHOP }
    ));
    console.log(`  ✓ Updated ${n(writeRes.records[0].get("updated"))} products`);

    // 4) Post-check using the user's own verification query
    if (!ALL) {
      const check = await session.run(
        `MATCH (p:Product {storeId: $shop}) WHERE p.price <= 150 RETURN count(p) AS c`,
        { shop: SHOP }
      );
      console.log(`\nVerification: products with p.price <= 150 for ${SHOP}: ${n(check.records[0].get("c"))}`);
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
