#!/usr/bin/env node

/**
 * Bronze Snake — find (and optionally delete) Neo4j products that aren't
 * visible on the storefront's /collections/all.
 *
 * Compares:
 *   - Neo4j products linked to Store {id:"bronze-snake-1.myshopify.com"}
 *   - Public handle list from https://bronzesnake.com/collections/all/products.json
 *
 * Reports the diff and, with --delete, removes the orphan Product nodes
 * (and their :HAS_VARIANT / :HAS_CATEGORY / :HAS_DEMOGRAPHIC / :HAS_PRODUCT
 * relationships).
 *
 * Default behavior is dry-run (just prints what WOULD be deleted).
 *
 * Usage:
 *   node apps/api/src/scripts/cleanup-bronzesnake-invisible.js                # dry-run, preview only
 *   node apps/api/src/scripts/cleanup-bronzesnake-invisible.js --delete       # actually delete
 *   node apps/api/src/scripts/cleanup-bronzesnake-invisible.js --max-delete-pct 5
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const STOREFRONT_HOST = "bronzesnake.com";
const STOREFRONT_FALLBACK = `${SHOP}`;

const args = process.argv.slice(2);
const DELETE = args.includes("--delete");
const pctIdx = args.indexOf("--max-delete-pct");
const MAX_DELETE_PCT = pctIdx !== -1 ? parseFloat(args[pctIdx + 1]) : 10;

const driver = neo4j.driver(
  process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
  neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
);

async function fetchStorefrontHandles() {
  console.log(`\n  Fetching storefront /collections/all from each candidate host...`);
  for (const host of [STOREFRONT_HOST, STOREFRONT_FALLBACK]) {
    const handles = new Set();
    try {
      let page = 1;
      while (page <= 50) {
        const url = `https://${host}/collections/all/products.json?limit=250&page=${page}`;
        const r = await fetch(url);
        if (!r.ok) break;
        const j = await r.json();
        if (!j.products?.length) break;
        for (const p of j.products) handles.add(p.handle);
        if (j.products.length < 250) break;
        page++;
      }
      if (handles.size > 0) {
        console.log(`  ✓ Got ${handles.size} visible handles via ${host}`);
        return handles;
      }
    } catch (e) {
      console.log(`  ✗ ${host} failed: ${e.message}`);
    }
  }
  throw new Error("Could not fetch storefront handles from any host");
}

async function fetchNeo4jProducts(session) {
  console.log(`\n  Fetching Bronze Snake products from Neo4j...`);
  const r = await session.run(
    `MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
     RETURN p.id AS id, p.handle AS handle, p.title AS title, p.category AS category, p.lastSeenAt AS lastSeenAt`,
    { shop: SHOP }
  );
  const products = r.records.map(rec => ({
    id: rec.get("id"),
    handle: rec.get("handle"),
    title: rec.get("title"),
    category: rec.get("category"),
    lastSeenAt: rec.get("lastSeenAt"),
  }));
  console.log(`  ✓ ${products.length} products in Neo4j`);
  return products;
}

async function deleteOrphans(session, ids) {
  // Collect the variants and categories the products-to-delete reference,
  // BEFORE the DETACH DELETE wipes those edges. We then scope the orphan
  // cleanup strictly to those refs — no other shop's data is touched.
  console.log(`\n  Collecting refs of the ${ids.length} products to delete...`);
  const refsRes = await session.run(
    `MATCH (p:Product) WHERE p.id IN $ids
     OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
     OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category)
     RETURN collect(DISTINCT v.id) AS variantIds, collect(DISTINCT c.name) AS categoryNames`,
    { ids }
  );
  const variantIds = refsRes.records[0].get("variantIds").filter(Boolean);
  const categoryNames = refsRes.records[0].get("categoryNames").filter(Boolean);
  console.log(`  → ${variantIds.length} variant IDs, ${categoryNames.length} category names referenced`);

  console.log(`\n  Deleting the ${ids.length} products and all their relationships...`);
  const r = await session.run(
    `MATCH (p:Product) WHERE p.id IN $ids
     DETACH DELETE p
     RETURN count(*) AS deleted`,
    { ids }
  );
  console.log(`  ✓ Deleted ${r.records[0].get("deleted").toNumber()} Product nodes (and all their edges)`);

  // Variants are 1-to-1 with products — if our deleted products' variants
  // now have zero :HAS_VARIANT incoming edges, they're truly orphaned and
  // can never belong to any other product.
  if (variantIds.length > 0) {
    console.log(`  Cleaning up Variants previously linked to those products...`);
    const v = await session.run(
      `MATCH (v:Variant) WHERE v.id IN $variantIds AND NOT (v)<-[:HAS_VARIANT]-()
       DELETE v
       RETURN count(*) AS deleted`,
      { variantIds }
    );
    console.log(`  ✓ Deleted ${v.records[0].get("deleted").toNumber()} orphan Variants (scoped to these products only)`);
  }

  // Categories are SHARED across stores. Only delete a Category if BOTH:
  //   (a) it was linked to one of the just-deleted Bronze Snake products, AND
  //   (b) no product anywhere in the DB still references it.
  // This guarantees we never touch a category another shop's products use.
  if (categoryNames.length > 0) {
    console.log(`  Cleaning up Categories previously linked to those products (only if no other product uses them)...`);
    const c = await session.run(
      `MATCH (c:Category) WHERE c.name IN $categoryNames AND NOT (c)<-[:HAS_CATEGORY]-()
       DELETE c
       RETURN count(*) AS deleted`,
      { categoryNames }
    );
    console.log(`  ✓ Deleted ${c.records[0].get("deleted").toNumber()} orphan Categories (scoped — other shops' categories untouched)`);
  }
}

async function main() {
  const session = driver.session();
  try {
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`  Bronze Snake — invisible product cleanup`);
    console.log(`  Shop:        ${SHOP}`);
    console.log(`  Mode:        ${DELETE ? "DELETE (irreversible!)" : "DRY-RUN (preview only)"}`);
    console.log(`  Safety cap:  --max-delete-pct ${MAX_DELETE_PCT}`);
    console.log(`══════════════════════════════════════════════════════════`);

    const [storefrontHandles, neo4jProducts] = await Promise.all([
      fetchStorefrontHandles(),
      fetchNeo4jProducts(session),
    ]);

    const orphans = neo4jProducts.filter(p => !storefrontHandles.has(p.handle));
    const pctToDelete = (orphans.length / neo4jProducts.length) * 100;

    console.log(`\n  ───────── DIFF ─────────`);
    console.log(`  Neo4j products:          ${neo4jProducts.length}`);
    console.log(`  Storefront visible:      ${storefrontHandles.size}`);
    console.log(`  Orphans (in Neo4j only): ${orphans.length}  (${pctToDelete.toFixed(1)}% of Neo4j)`);

    if (orphans.length === 0) {
      console.log(`\n  ✓ Nothing to do — Neo4j is already in sync with the storefront.\n`);
      return;
    }

    console.log(`\n  ─── Orphan products (sample of first 30) ───`);
    orphans.slice(0, 30).forEach(p => {
      console.log(`    - "${p.title}"`);
      console.log(`        handle:   ${p.handle}`);
      console.log(`        id:       ${p.id}`);
      console.log(`        category: ${p.category || "(none)"}`);
      console.log(`        lastSeen: ${p.lastSeenAt || "(never)"}`);
    });
    if (orphans.length > 30) {
      console.log(`    ... and ${orphans.length - 30} more`);
    }

    if (pctToDelete > MAX_DELETE_PCT) {
      console.log(`\n  ⛔ ABORT: would delete ${pctToDelete.toFixed(1)}% of products, which exceeds`);
      console.log(`     the --max-delete-pct safety cap of ${MAX_DELETE_PCT}%.`);
      console.log(`     If you really want to proceed, re-run with --max-delete-pct ${Math.ceil(pctToDelete + 1)}`);
      process.exit(1);
    }

    if (!DELETE) {
      console.log(`\n  ─── DRY-RUN ───`);
      console.log(`  No changes made. Re-run with --delete to actually remove these from Neo4j:`);
      console.log(`    node apps/api/src/scripts/cleanup-bronzesnake-invisible.js --delete`);
      return;
    }

    await deleteOrphans(session, orphans.map(o => o.id));

    console.log(`\n  ─── VERIFY ───`);
    const after = await session.run(
      `MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product) RETURN count(p) AS n`,
      { shop: SHOP }
    );
    console.log(`  Remaining products in Neo4j: ${after.records[0].get("n").toNumber()}`);
    console.log(`  Should match storefront:      ${storefrontHandles.size}`);
    console.log(`\n  ✓ Done.\n`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error("\nError:", e.message);
  console.error(e.stack);
  process.exit(1);
});
