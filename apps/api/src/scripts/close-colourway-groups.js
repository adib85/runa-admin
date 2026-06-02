#!/usr/bin/env node

/**
 * Complete ("close") colourway groups in Neo4j — NO Shopify calls.
 *
 * Background: on bronzesnake.com a single style is N separate products, one per
 * colour, tied together by the Shopify metafield `custom.related_colourways`.
 * The nightly sync (Step 1, sync-modular.js) stores each product's OWN copy of
 * that metafield as the node property `p.related_colourways`. Those lists are
 * often PARTIAL/asymmetric — e.g. Alma Black → [Bone] only, while Alma Slate →
 * [Black, Bone, Chocolate]. This script unions every product's stored list into
 * connected groups (transitive closure) and writes the COMPLETE sibling set +
 * bidirectional clique edges back to every member, so each variant lists all
 * the others.
 *
 * Reads & writes ONLY Neo4j — it never touches Shopify. Scoped to ONE store
 * (default bronze-snake-1.myshopify.com via --shop); other shops are untouched.
 * Designed to run as a step in sync-bronzesnake-all.sh right AFTER the product
 * sync, so the completion is self-healing on every nightly run.
 *
 * Why union-find over the STORED PROPERTY (not edge traversal): Step 1 rewrites
 * each product's RELATED_COLOURWAY edges from its own (partial) list. With
 * asymmetric metafields that can FRAGMENT a group's edges — a well-connected
 * variant (e.g. Slate) can end up isolated depending on batch order. The stored
 * `related_colourways` property preserves each product's raw list, so the union
 * always recovers the full group regardless of edge state.
 *
 * Default is dry-run. Use --apply to write.
 *
 * Usage:
 *   node apps/api/src/scripts/close-colourway-groups.js                    # dry-run, bronze snake
 *   node apps/api/src/scripts/close-colourway-groups.js --apply            # write
 *   node apps/api/src/scripts/close-colourway-groups.js --shop foo.myshopify.com --apply
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
const shopIdx = args.indexOf("--shop");
const SHOP = shopIdx !== -1 && args[shopIdx + 1] ? args[shopIdx + 1] : "bronze-snake-1.myshopify.com";

// Union-find transitive closure. Treats every stored sibling reference as an
// UNDIRECTED edge, groups products into connected components, and returns
// Map<id, completeSiblingIds[]> (self removed) — every member of a component
// gets the full set of the others.
function buildClosedGroups(products) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const p of products) {
    if (!parent.has(p.id)) parent.set(p.id, p.id);
    for (const sib of p.siblings) if (!parent.has(sib)) parent.set(sib, sib);
  }
  for (const p of products) for (const sib of p.siblings) union(p.id, sib);

  const components = new Map(); // root -> Set(ids)
  for (const id of parent.keys()) {
    const root = find(id);
    if (!components.has(root)) components.set(root, new Set());
    components.get(root).add(id);
  }

  const closed = new Map(); // id -> complete sibling list (self removed)
  for (const members of components.values()) {
    const arr = [...members];
    for (const id of members) closed.set(id, arr.filter((x) => x !== id));
  }
  return closed;
}

async function main() {
  console.log(`Mode:   ${APPLY ? "APPLY (will write to Neo4j)" : "DRY-RUN"}`);
  console.log(`Shop:   ${SHOP}`);
  console.log(`Source: Neo4j node property p.related_colourways (no Shopify calls)\n`);

  if (!process.env.NEO4J_URI) throw new Error("NEO4J_URI not set (check .env)");
  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
  );
  const session = driver.session();

  try {
    // 1) Read every product + its stored (partial) sibling list for this store.
    const res = await session.run(
      `MATCH (p:Product {storeId: $shop})
       RETURN p.id AS id, p.related_colourways AS siblings`,
      { shop: SHOP }
    );
    const existing = new Set(res.records.map(r => r.get("id")));
    const products = res.records.map(r => {
      const id = r.get("id");
      const sibs = (r.get("siblings") || []).map(String).filter(s => s && s !== id);
      return { id, siblings: sibs };
    });
    console.log(`  ✓ ${products.length} products in Neo4j for ${SHOP}`);

    // 2) Close the groups (union-find over the stored partial lists).
    const closed = buildClosedGroups(products);

    let gained = 0, withGroup = 0, noGroup = 0, totalEdges = 0, missingRefs = 0;
    const rows = [];
    for (const p of products) {
      const full = closed.get(p.id) || p.siblings; // COMPLETE group, not the raw partial list
      if (full.length > p.siblings.length) gained++;
      const present = full.filter(sid => existing.has(sid));
      missingRefs += full.length - present.length;
      if (present.length) withGroup++; else noGroup++;
      totalEdges += present.length;
      rows.push({ id: p.id, allSiblings: full, siblings: present });
    }

    console.log(`  ✓ Closed colourway groups — ${gained} products gain extra siblings vs their stored (partial) list\n`);
    console.log(`Plan:`);
    console.log(`  ${rows.length} products in Neo4j for this store`);
    console.log(`    with ≥1 colourway sibling: ${withGroup}`);
    console.log(`    standalone (no siblings):  ${noGroup}`);
    console.log(`  ${missingRefs} sibling references point to products not in Neo4j (skipped for edges)`);
    console.log(`  ${totalEdges} directed edges to create (×2 both directions, MERGE-deduped)\n`);

    const samples = rows.filter(r => r.siblings.length).slice(0, 12);
    console.log(`Sample (first ${samples.length} with siblings):`);
    for (const s of samples) {
      console.log(`  ${String(s.id).padEnd(16)} → ${s.siblings.length} sibling(s): ${s.siblings.join(", ")}`);
    }
    console.log("");

    if (!APPLY) {
      console.log(`[DRY-RUN] Would set the complete related_colourways + clique edges on ${rows.length} products.`);
      console.log(`Run with --apply to commit.`);
      return;
    }

    // 3) Write complete property + clique edges, scoped to this store, in batches.
    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);

      // a) Set the complete sibling list on every product in the slice.
      await session.executeWrite(tx => tx.run(
        `UNWIND $rows AS row
         MATCH (p:Product {id: row.id})
         WHERE p.storeId = $shop
         SET p.related_colourways = row.allSiblings`,
        { rows: slice, shop: SHOP }
      ));

      // b) Clear existing colourway edges for these products (idempotent re-run).
      await session.executeWrite(tx => tx.run(
        `UNWIND $rows AS row
         MATCH (a:Product {id: row.id})-[r:RELATED_COLOURWAY]-()
         DELETE r`,
        { rows: slice }
      ));

      // c) Re-create edges (both directions) to siblings that exist as nodes.
      await session.executeWrite(tx => tx.run(
        `UNWIND $rows AS row
         MATCH (a:Product {id: row.id})
         UNWIND row.siblings AS sibId
         MATCH (b:Product {id: sibId})
         MERGE (a)-[:RELATED_COLOURWAY]->(b)
         MERGE (b)-[:RELATED_COLOURWAY]->(a)`,
        { rows: slice }
      ));

      done += slice.length;
      process.stdout.write(`  wrote ${done}/${rows.length}\r`);
    }
    console.log(`  ✓ Wrote ${done} products`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
