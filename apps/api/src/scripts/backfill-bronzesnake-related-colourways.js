#!/usr/bin/env node

/**
 * Bronze Snake — backfill the colourway relationship into Neo4j.
 *
 * On bronzesnake.com a single style exists as N separate products, one per
 * color (e.g. `collar-lined-jacket-black`, `-dark-brown`, `-khaki`). They are
 * tied together by the Shopify metafield `custom.related_colourways`
 * (type: list.product_reference). In theory every member lists the whole group, but in
 * practice the metafields are often PARTIAL/asymmetric (e.g. Alma Black lists only [Bone]
 * while Alma Slate lists [Black, Bone, Chocolate]). So this script unions all links into
 * connected groups (transitive closure) and writes the COMPLETE sibling set to EVERY
 * member — partial metafields self-heal as long as the group is connected by some link.
 *
 * This script mirrors that relationship into Neo4j in two forms:
 *   1. Property:     p.related_colourways = [<bare sibling ids>]  (self removed)
 *   2. Relationship: (p)-[:RELATED_COLOURWAY]->(sibling)  both directions
 *
 * Only links siblings that exist as Product nodes for this store; references to
 * missing/unpublished products are skipped (and counted). Idempotent: clears a
 * product's existing :RELATED_COLOURWAY edges before re-creating, so re-runs
 * reflect the current Shopify state. Matches the logic now wired into the
 * nightly modular sync (shopify.js + neo4j.js).
 *
 * Default is dry-run. Use --apply to write.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-bronzesnake-related-colourways.js
 *   node apps/api/src/scripts/backfill-bronzesnake-related-colourways.js --apply
 *   node apps/api/src/scripts/backfill-bronzesnake-related-colourways.js --apply --limit 50
 *   node apps/api/src/scripts/backfill-bronzesnake-related-colourways.js --token shpat_xxxx
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GraphQLClient, gql } from "graphql-request";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const API_VERSION = "2024-10";
const PAGE_SIZE = 250;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const tokenIdx = args.indexOf("--token");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const PRODUCTS_QUERY = gql`
  query ($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          relatedColourways: metafield(namespace: "custom", key: "related_colourways") { value }
        }
      }
    }
  }
`;

async function fetchAccessToken() {
  if (tokenIdx !== -1 && args[tokenIdx + 1]) return args[tokenIdx + 1];
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  if (process.env.SHOP_TOKEN) return process.env.SHOP_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const j = await r.json();
  const t = j?.data?.accessToken;
  if (!t) throw new Error(`No accessToken for ${SHOP} (pass --token shpat_... or set ACCESS_TOKEN)`);
  return t;
}

// Parse `custom.related_colourways` (JSON array of product GIDs, self-inclusive)
// into a deduped list of bare sibling ids with self removed.
function parseRelatedColourways(value, selfId) {
  if (!value) return [];
  let arr;
  try { arr = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const self = String(selfId);
  const seen = new Set();
  const out = [];
  for (const gid of arr) {
    const idStr = String(gid).replace("gid://shopify/Product/", "").trim();
    if (!idStr || idStr === self || seen.has(idStr)) continue;
    seen.add(idStr);
    out.push(idStr);
  }
  return out;
}

// Complete the colourway groups. The metafields are often PARTIAL/asymmetric — e.g. Alma
// Black lists only [Bone] while Alma Slate lists [Black, Bone, Chocolate]. As long as the
// group is connected by *some* link, treating every listed reference as an UNDIRECTED edge
// and computing connected components recovers the FULL group, then we give every member the
// complete sibling list. Returns Map<id, completeSiblingIds[]> (self removed).
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

async function fetchAllShopifyProducts(client) {
  const products = [];
  let cursor = null;
  let hasNext = true;
  const filter = "status:active AND published_status:published";
  while (hasNext) {
    const res = await client.request(PRODUCTS_QUERY, { first: PAGE_SIZE, after: cursor, query: filter });
    for (const edge of res.products.edges) {
      const n = edge.node;
      const id = n.id.replace("gid://shopify/Product/", "");
      products.push({
        id,
        handle: n.handle,
        title: n.title,
        siblings: parseRelatedColourways(n.relatedColourways?.value, id),
      });
    }
    hasNext = res.products.pageInfo.hasNextPage;
    cursor = res.products.pageInfo.endCursor;
    process.stdout.write(`  fetched ${products.length}\r`);
  }
  console.log(`  ✓ Fetched ${products.length} products from Shopify\n`);
  return products;
}

async function fetchExistingProductIds(session) {
  const r = await session.run(
    `MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product) RETURN p.id AS id`,
    { shop: SHOP }
  );
  return new Set(r.records.map(rec => rec.get("id")));
}

async function applyUpdates(session, rows) {
  // rows: [{ id, siblings: [existing-in-neo4j ids] }]
  const BATCH = 200;
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);

    // 1) Set the property on every product in the slice. Stores the FULL
    //    sibling list from the metafield (matches the nightly sync), even if
    //    some siblings aren't in Neo4j; edges below only link existing nodes.
    await session.executeWrite(tx => tx.run(
      `UNWIND $rows AS row
       MATCH (p:Product {id: row.id})
       WHERE p.storeId = $shop
       SET p.related_colourways = row.allSiblings`,
      { rows: slice, shop: SHOP }
    ));

    // 2) Clear existing colourway edges for these products (idempotent re-run).
    await session.executeWrite(tx => tx.run(
      `UNWIND $rows AS row
       MATCH (a:Product {id: row.id})-[r:RELATED_COLOURWAY]-()
       DELETE r`,
      { rows: slice }
    ));

    // 3) Re-create edges (both directions) to siblings that exist as nodes.
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
}

async function main() {
  const token = await fetchAccessToken();
  const client = new GraphQLClient(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
  );

  console.log(`Mode: ${APPLY ? "APPLY (will write to Neo4j)" : "DRY-RUN"}`);
  console.log(`Limit: ${LIMIT === Infinity ? "no limit" : LIMIT}`);
  console.log(`Shop: ${SHOP}\n`);

  console.log("Fetching Shopify products…");
  let products = await fetchAllShopifyProducts(client);

  // Close the colourway groups BEFORE any --limit slicing, so grouping uses the full set.
  const closed = buildClosedGroups(products);
  const gained = products.filter(p => (closed.get(p.id) || []).length > p.siblings.length).length;
  console.log(`  ✓ Closed colourway groups — ${gained} products gain extra siblings vs their raw metafield\n`);

  if (LIMIT !== Infinity) products = products.slice(0, LIMIT);

  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
  );
  const session = driver.session();

  try {
    console.log("Fetching existing product ids from Neo4j…");
    const existing = await fetchExistingProductIds(session);
    console.log(`  ✓ ${existing.size} products in Neo4j for ${SHOP}\n`);

    let withGroup = 0, noGroup = 0, notInNeo4j = 0;
    let totalRefs = 0, missingRefs = 0, totalEdges = 0;
    const rows = []; // { id, handle, siblings: [existing ids] }

    for (const p of products) {
      if (!existing.has(p.id)) { notInNeo4j++; continue; }
      const fullSiblings = closed.get(p.id) || p.siblings; // COMPLETE group from closure, not raw metafield
      totalRefs += fullSiblings.length;
      const present = fullSiblings.filter(sid => existing.has(sid));
      missingRefs += fullSiblings.length - present.length;
      if (present.length) withGroup++; else noGroup++;
      totalEdges += present.length; // directed-each-way pairs are MERGEd, counted once per (a→b)
      rows.push({ id: p.id, handle: p.handle, allSiblings: fullSiblings, siblings: present });
    }

    console.log(`Plan:`);
    console.log(`  ${rows.length} products in Neo4j to update`);
    console.log(`    with ≥1 colourway sibling: ${withGroup}`);
    console.log(`    standalone (no siblings):  ${noGroup}`);
    console.log(`  ${notInNeo4j} Shopify products not present in Neo4j (skip)`);
    console.log(`  ${totalRefs} total sibling references; ${missingRefs} point to products not in Neo4j (skipped)`);
    console.log(`  ${totalEdges} directed edges to create (×2 for both directions, MERGE-deduped)\n`);

    const samples = rows.filter(r => r.siblings.length).slice(0, 12);
    console.log(`Sample (first ${samples.length} with siblings):`);
    for (const s of samples) {
      console.log(`  ${s.handle.padEnd(45)} → ${s.siblings.length} sibling(s): ${s.siblings.join(", ")}`);
    }
    console.log("");

    if (!APPLY) {
      console.log(`[DRY-RUN] Would set related_colourways on ${rows.length} products and create colourway edges.`);
      console.log(`Run with --apply to commit.`);
      return;
    }

    console.log(`Writing to Neo4j…`);
    await applyUpdates(session, rows);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
