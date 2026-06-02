#!/usr/bin/env node

/**
 * Bronze Snake — backfill `color` + `colorEmbedding` on every Product node in
 * Neo4j.
 *
 * These are the PRODUCT-level fields the recommendation/search query scores
 * with `gds.similarity.cosine(p.colorEmbedding, $colorEmbedding)`. They were
 * never populated by the modular sync for Bronze Snake (detectColorFromImage
 * is disabled and variant option-embeddings aren't generated), so every BS
 * product currently has color=null / colorEmbedding=null.
 *
 * Color source (per the product, NOT the canonical storefront bucket):
 *   1. The Shopify "Color"/"Colour" option value (e.g. "Deep Ocean").
 *   2. Fallback for single-variant products (e.g. fragrances) that have no
 *      Color option: the raw `customAttributes.colour` metafield value.
 *
 * Stored as `color: "color: <lowercased value>"` and
 * `colorEmbedding = embedding("color: <value>")` (text-embedding-3-small,
 * 1536-dim) — byte-compatible with what the query side embeds
 * (`color: ${color.toLowerCase()}`).
 *
 * Default is dry-run. Use --apply to write.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-bronzesnake-product-color.js
 *   node apps/api/src/scripts/backfill-bronzesnake-product-color.js --apply
 *   node apps/api/src/scripts/backfill-bronzesnake-product-color.js --apply --limit 50
 *   node apps/api/src/scripts/backfill-bronzesnake-product-color.js --token shpat_xxxx
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
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_CONCURRENCY = 8;
const COLOR_OPTION_NAMES = new Set(["color", "colour", "culoare"]);

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
          options { name values }
          canonicalColorMeta: metafield(namespace: "customAttributes", key: "colour") { value }
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

// Mirrors ShopifyProvider.resolveProductColorValue: real product color first
// (Shopify Color option), raw colour metafield as fallback.
function resolveColorValue(product) {
  const opt = (product.options || []).find(o => COLOR_OPTION_NAMES.has(String(o.name || "").toLowerCase()));
  const optValue = opt?.values?.find(v => String(v || "").trim()) || null;
  return optValue || product.rawColorMeta || null;
}

function colorText(value) {
  return `color: ${String(value).toLowerCase().trim()}`;
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
      products.push({
        id: n.id.replace("gid://shopify/Product/", ""),
        handle: n.handle,
        title: n.title,
        options: n.options || [],
        rawColorMeta: n.canonicalColorMeta?.value || null,
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

async function generateEmbedding(inputText) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputText }),
  });
  const j = await r.json();
  const emb = j?.data?.[0]?.embedding;
  if (!emb) throw new Error(`embedding failed for "${inputText}": ${JSON.stringify(j).slice(0, 200)}`);
  return emb;
}

// Embed each UNIQUE color string once (many products share a color).
async function buildEmbeddingCache(uniqueTexts) {
  const cache = new Map();
  let cursor = 0;
  let done = 0;
  const texts = [...uniqueTexts];
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= texts.length) return;
      const t = texts[idx];
      cache.set(t, await generateEmbedding(t));
      done++;
      process.stdout.write(`  embedded ${done}/${texts.length} unique colors\r`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, texts.length) }, worker));
  console.log("");
  return cache;
}

async function applyUpdates(session, updates) {
  let done = 0;
  const BATCH = 100;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    await session.executeWrite(tx => tx.run(
      `UNWIND $rows AS row
       MATCH (p:Product {id: row.id})
       WHERE p.storeId = $shop
       SET p.color = row.color, p.colorEmbedding = row.colorEmbedding`,
      { rows: slice, shop: SHOP }
    ));
    done += slice.length;
    process.stdout.write(`  wrote ${done}/${updates.length}\r`);
  }
  console.log(`  ✓ Wrote ${done} updates`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing in .env");

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

    let fromOption = 0, fromMeta = 0, noColor = 0, notInNeo4j = 0;
    const plan = []; // { id, handle, color }
    const uniqueTexts = new Set();

    for (const p of products) {
      if (!existing.has(p.id)) { notInNeo4j++; continue; }
      const opt = (p.options || []).find(o => COLOR_OPTION_NAMES.has(String(o.name || "").toLowerCase()));
      const optValue = opt?.values?.find(v => String(v || "").trim()) || null;
      const value = optValue || p.rawColorMeta || null;
      if (!value) { noColor++; continue; }
      if (optValue) fromOption++; else fromMeta++;
      const text = colorText(value);
      uniqueTexts.add(text);
      plan.push({ id: p.id, handle: p.handle, color: text });
    }

    console.log(`Plan:`);
    console.log(`  ${plan.length} products → set color + colorEmbedding`);
    console.log(`    from Shopify Color option:   ${fromOption}`);
    console.log(`    from colour metafield (fallback): ${fromMeta}`);
    console.log(`  ${noColor} products have no color signal at all (skip)`);
    console.log(`  ${notInNeo4j} Shopify products not present in Neo4j (skip)`);
    console.log(`  ${uniqueTexts.size} unique color strings to embed\n`);

    console.log(`Sample (first 15):`);
    for (const u of plan.slice(0, 15)) {
      console.log(`  ${u.handle.padEnd(45)} → ${u.color}`);
    }
    console.log("");

    if (!APPLY) {
      console.log(`[DRY-RUN] Would embed ${uniqueTexts.size} colors and write ${plan.length} products.`);
      console.log(`Run with --apply to commit.`);
      return;
    }

    console.log(`Generating embeddings…`);
    const cache = await buildEmbeddingCache(uniqueTexts);

    const updates = plan.map(u => ({ id: u.id, color: u.color, colorEmbedding: cache.get(u.color) }))
      .filter(u => Array.isArray(u.colorEmbedding));

    console.log(`\nWriting ${updates.length} products to Neo4j…`);
    await applyUpdates(session, updates);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
