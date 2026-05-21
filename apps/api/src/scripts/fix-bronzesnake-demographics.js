#!/usr/bin/env node

/**
 * Bronze Snake — recompute & rebuild :HAS_DEMOGRAPHIC edges in Neo4j.
 *
 * Re-runs the current `detectBronzeSnakeDemographic` rule (in
 * apps/api/src/sync/providers/shopify.js) against ALL Bronze Snake products
 * that are currently in Neo4j, then replaces their HAS_DEMOGRAPHIC edges to
 * match. Does NOT touch images, embeddings, AI properties, categories, or
 * Shopify itself.
 *
 * Source of truth for each product:
 *   - collection handles (mens-* / womens-*)
 *   - product_type prefix (men* / women*)
 *
 * Default is dry-run. Use --apply to actually write.
 *
 * Usage:
 *   node apps/api/src/scripts/fix-bronzesnake-demographics.js
 *   node apps/api/src/scripts/fix-bronzesnake-demographics.js --apply
 *   node apps/api/src/scripts/fix-bronzesnake-demographics.js --apply --token shpat_xxxx
 *   node apps/api/src/scripts/fix-bronzesnake-demographics.js --apply --max-change-pct 80
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GraphQLClient, gql } from "graphql-request";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { ShopifyProvider } from "../sync/providers/shopify.js";

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const SHOPIFY_API_VERSION = "2024-10";
const PAGE_SIZE = 250;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const tokenIdx = args.indexOf("--token");
const pctIdx = args.indexOf("--max-change-pct");
const MAX_CHANGE_PCT = pctIdx !== -1 ? parseFloat(args[pctIdx + 1]) : 100;
const SHOW_EXAMPLES = 8;

const MIN_QUERY = gql`
  query ($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          productType
          collections(first: 50) { edges { node { handle } } }
        }
      }
    }
  }
`;

async function fetchAccessToken() {
  if (tokenIdx !== -1 && args[tokenIdx + 1]) return args[tokenIdx + 1];
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const j = await r.json();
  const t = j?.data?.accessToken;
  if (!t) throw new Error(`No accessToken for ${SHOP} (pass --token shpat_... or set ACCESS_TOKEN)`);
  return t;
}

async function fetchAllShopifyProducts(accessToken) {
  const client = new GraphQLClient(
    `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    { headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" } }
  );
  const filter = "status:active AND published_status:published";

  const products = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const res = await client.request(MIN_QUERY, { first: PAGE_SIZE, after: cursor, query: filter });
    for (const edge of res.products.edges) {
      const node = edge.node;
      products.push({
        id: node.id.replace("gid://shopify/Product/", ""),
        handle: node.handle,
        title: node.title,
        product_type: node.productType || "",
        collections: (node.collections?.edges || []).map(e => ({ handle: e.node.handle })),
      });
    }
    hasNext = res.products.pageInfo.hasNextPage;
    cursor = res.products.pageInfo.endCursor;
    process.stdout.write(`  fetched ${products.length}\r`);
  }
  console.log(`  ✓ Fetched ${products.length} products from Shopify (lean query)\n`);
  return products;
}

async function fetchNeo4jProducts(session) {
  const r = await session.run(
    `MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
     OPTIONAL MATCH (p)-[:HAS_DEMOGRAPHIC]->(d:Demographic)
     RETURN p.id AS id, p.handle AS handle, p.title AS title, collect(DISTINCT d.name) AS demographics`,
    { shop: SHOP }
  );
  return r.records.map(rec => ({
    id: rec.get("id"),
    handle: rec.get("handle"),
    title: rec.get("title"),
    demographics: (rec.get("demographics") || []).filter(Boolean).map(s => s.toLowerCase()).sort(),
  }));
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fmtDemo(arr) {
  return arr.length ? `[${arr.join(", ")}]` : "[]";
}

async function applyUpdates(session, updates) {
  let done = 0;
  const total = updates.length;
  const BATCH = 200;
  for (let i = 0; i < total; i += BATCH) {
    const slice = updates.slice(i, i + BATCH).map(u => ({ id: u.id, demographics: u.next }));
    await session.executeWrite(tx => tx.run(
      `UNWIND $rows AS row
       MATCH (p:Product {id: row.id})
       OPTIONAL MATCH (p)-[r:HAS_DEMOGRAPHIC]->()
       DELETE r
       WITH p, row
       FOREACH (name IN row.demographics |
         MERGE (d:Demographic {name: name})
         MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)
       )`,
      { rows: slice }
    ));
    done += slice.length;
    process.stdout.write(`  applied ${done}/${total}\r`);
  }
  console.log(`  ✓ Applied ${done} demographic rebuilds\n`);
}

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Bronze Snake — rebuild HAS_DEMOGRAPHIC edges`);
  console.log(`  Shop:       ${SHOP}`);
  console.log(`  Mode:       ${APPLY ? "APPLY (writes to Neo4j)" : "DRY-RUN (preview only)"}`);
  console.log(`  Safety cap: --max-change-pct ${MAX_CHANGE_PCT}`);
  console.log(`══════════════════════════════════════════════════════════\n`);

  const accessToken = await fetchAccessToken();

  // Detection lives on ShopifyProvider; the constructor is side-effect free.
  const provider = new ShopifyProvider({
    shopName: SHOP,
    accessToken,
    region: "us-east-1",
    forceAll: true,
    dryRun: true,
    demographic: "woman",
  });

  const driver = neo4j.driver(
    process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
    neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
  );
  const session = driver.session();

  try {
    console.log(`  Fetching products from Shopify...`);
    const shopifyProducts = await fetchAllShopifyProducts(accessToken);

    console.log(`  Fetching products from Neo4j...`);
    const neo4jProducts = await fetchNeo4jProducts(session);
    console.log(`  ✓ ${neo4jProducts.length} products in Neo4j\n`);

    const shopifyById = new Map(shopifyProducts.map(p => [p.id, p]));

    const updates = [];
    const unchanged = [];
    const missingFromShopify = [];

    for (const np of neo4jProducts) {
      const sp = shopifyById.get(np.id);
      if (!sp) {
        missingFromShopify.push(np);
        continue;
      }
      const next = provider.detectBronzeSnakeDemographic(sp).slice().sort();
      if (sameSet(np.demographics, next)) {
        unchanged.push({ ...np, next });
      } else {
        updates.push({ ...np, next, sp });
      }
    }

    // ─── Distribution after rebuild ────────────────────────────────────
    let nextOnlyMan = 0, nextOnlyWoman = 0, nextDual = 0, nextNone = 0;
    for (const np of neo4jProducts) {
      const sp = shopifyById.get(np.id);
      if (!sp) continue;
      const next = provider.detectBronzeSnakeDemographic(sp);
      if (next.length === 0) nextNone++;
      else if (next.includes("man") && next.includes("woman")) nextDual++;
      else if (next.includes("man")) nextOnlyMan++;
      else if (next.includes("woman")) nextOnlyWoman++;
    }

    console.log(`══════════════ DISTRIBUTION (post-rebuild) ══════════════`);
    const total = nextOnlyMan + nextOnlyWoman + nextDual + nextNone;
    const pct = n => `${String(n).padStart(4)}  (${total ? ((n / total) * 100).toFixed(1) : "0.0"}%)`;
    console.log(`  only-man          ${pct(nextOnlyMan)}`);
    console.log(`  only-woman        ${pct(nextOnlyWoman)}`);
    console.log(`  both man+woman    ${pct(nextDual)}`);
    console.log(`  no demographic    ${pct(nextNone)}   ← won't appear in any gendered query`);
    console.log(`\n  Query "man"   → ${nextOnlyMan + nextDual} products`);
    console.log(`  Query "woman" → ${nextOnlyWoman + nextDual} products\n`);

    // ─── Diff vs current ──────────────────────────────────────────────
    console.log(`══════════════ DIFF vs CURRENT NEO4J ══════════════`);
    console.log(`  Neo4j products:        ${neo4jProducts.length}`);
    console.log(`  In Shopify (matched):  ${neo4jProducts.length - missingFromShopify.length}`);
    console.log(`  Missing from Shopify:  ${missingFromShopify.length}  (skipped — run cleanup-bronzesnake-invisible.js)`);
    console.log(`  Unchanged:             ${unchanged.length}`);
    console.log(`  Will change:           ${updates.length}\n`);

    // Bucket the changes by transition for easier review.
    const transitions = new Map();
    for (const u of updates) {
      const key = `${fmtDemo(u.demographics)}  →  ${fmtDemo(u.next)}`;
      if (!transitions.has(key)) transitions.set(key, []);
      transitions.get(key).push(u);
    }
    if (transitions.size > 0) {
      console.log(`  ─── Transitions ───`);
      const sorted = [...transitions.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [key, list] of sorted) {
        console.log(`    ${String(list.length).padStart(5)}  ${key}`);
      }
      console.log();

      // Show a few examples per transition
      for (const [key, list] of sorted) {
        console.log(`  ─── Examples: ${key} ───`);
        for (const u of list.slice(0, SHOW_EXAMPLES)) {
          const handles = u.sp.collections.map(c => c.handle).slice(0, 6).join(", ") || "(none)";
          console.log(`    • ${u.title || u.sp.title}`);
          console.log(`        id:           ${u.id}`);
          console.log(`        product_type: ${u.sp.product_type || "(empty)"}`);
          console.log(`        collections:  ${handles}${u.sp.collections.length > 6 ? ` (+${u.sp.collections.length - 6} more)` : ""}`);
        }
        if (list.length > SHOW_EXAMPLES) console.log(`    ... and ${list.length - SHOW_EXAMPLES} more`);
        console.log();
      }
    }

    if (updates.length === 0) {
      console.log(`  ✓ Nothing to do — all demographics already match the new rule.\n`);
      return;
    }

    const changePct = (updates.length / Math.max(1, neo4jProducts.length - missingFromShopify.length)) * 100;
    if (changePct > MAX_CHANGE_PCT) {
      console.log(`  ⛔ ABORT: would change ${changePct.toFixed(1)}% of products, exceeding`);
      console.log(`     --max-change-pct ${MAX_CHANGE_PCT}. Re-run with --max-change-pct ${Math.ceil(changePct + 1)}`);
      console.log(`     if this is expected.`);
      process.exit(1);
    }

    if (!APPLY) {
      console.log(`  ─── DRY-RUN ───`);
      console.log(`  No changes made. Re-run with --apply to actually rebuild edges:`);
      console.log(`    node apps/api/src/scripts/fix-bronzesnake-demographics.js --apply\n`);
      return;
    }

    console.log(`  Applying ${updates.length} updates...`);
    await applyUpdates(session, updates);

    console.log(`  ─── VERIFY ───`);
    const verify = await session.run(
      `MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
       OPTIONAL MATCH (p)-[:HAS_DEMOGRAPHIC]->(d:Demographic)
       WITH p, collect(DISTINCT d.name) AS demos
       RETURN
         sum(CASE WHEN size(demos) = 0 THEN 1 ELSE 0 END) AS none,
         sum(CASE WHEN "man" IN demos AND "woman" IN demos THEN 1 ELSE 0 END) AS dual,
         sum(CASE WHEN "man" IN demos AND NOT "woman" IN demos THEN 1 ELSE 0 END) AS onlyMan,
         sum(CASE WHEN "woman" IN demos AND NOT "man" IN demos THEN 1 ELSE 0 END) AS onlyWoman`,
      { shop: SHOP }
    );
    const v = verify.records[0];
    console.log(`  Neo4j now reports:`);
    console.log(`    only-man:        ${v.get("onlyMan").toNumber()}`);
    console.log(`    only-woman:      ${v.get("onlyWoman").toNumber()}`);
    console.log(`    both man+woman:  ${v.get("dual").toNumber()}`);
    console.log(`    no demographic:  ${v.get("none").toNumber()}`);
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
