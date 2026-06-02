#!/usr/bin/env node

/**
 * Bronze Snake — backfill `canonicalColor` on every Product node in Neo4j.
 *
 * Source of truth:
 *   1. Shopify metafield `customAttributes.colour` (single_line_text_field)
 *      — same value that powers the storefront filter
 *      filter.p.m.customAttributes.colour. Used as-is when present.
 *   2. For products WITHOUT that metafield, Gemini bucketing into one of
 *      33 canonical colors using the product's main image + title
 *      (only runs when --gemini is passed).
 *
 * Also creates the Neo4j index on (p.canonicalColor) the first time it runs.
 *
 * Default is dry-run. Use --apply to write.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-bronzesnake-canonical-color.js
 *   node apps/api/src/scripts/backfill-bronzesnake-canonical-color.js --apply
 *   node apps/api/src/scripts/backfill-bronzesnake-canonical-color.js --apply --gemini
 *   node apps/api/src/scripts/backfill-bronzesnake-canonical-color.js --apply --gemini --limit 50
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GraphQLClient, gql } from "graphql-request";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import {
  detectCanonicalColor,
  BRONZE_SNAKE_CANONICAL_COLORS,
  normalizeCanonicalColor,
} from "../sync/services/detect-canonical-color.js";

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const API_VERSION = "2024-10";
const PAGE_SIZE = 250;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const USE_GEMINI = args.includes("--gemini");
const tokenIdx = args.indexOf("--token");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const GEMINI_CONCURRENCY = 8;

const PRODUCTS_QUERY = gql`
  query ($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          featuredImage { url }
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
        imageUrl: n.featuredImage?.url || null,
        metafieldColor: normalizeCanonicalColor(n.canonicalColorMeta?.value),
      });
    }
    hasNext = res.products.pageInfo.hasNextPage;
    cursor = res.products.pageInfo.endCursor;
    process.stdout.write(`  fetched ${products.length}\r`);
  }
  console.log(`  ✓ Fetched ${products.length} products from Shopify\n`);
  return products;
}

async function fetchExistingCanonicalColors(session) {
  const r = await session.run(
    `MATCH (s:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
     RETURN p.id AS id, p.canonicalColor AS canonicalColor`,
    { shop: SHOP }
  );
  const map = new Map();
  for (const rec of r.records) {
    map.set(rec.get("id"), rec.get("canonicalColor") || null);
  }
  return map;
}

async function ensureIndex(session) {
  await session.run(
    `CREATE INDEX product_canonical_color IF NOT EXISTS FOR (p:Product) ON (p.canonicalColor)`
  );
  console.log("  ✓ Index product_canonical_color ensured");
}

async function applyUpdates(session, updates) {
  let done = 0;
  const BATCH = 200;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH).map(u => ({ id: u.id, canonicalColor: u.color }));
    await session.executeWrite(tx => tx.run(
      `UNWIND $rows AS row
       MATCH (p:Product {id: row.id})
       SET p.canonicalColor = row.canonicalColor`,
      { rows: slice }
    ));
    done += slice.length;
    process.stdout.write(`  wrote ${done}/${updates.length}\r`);
  }
  console.log(`  ✓ Wrote ${done} updates`);
}

async function detectWithConcurrency(items, concurrency, fn) {
  const results = [];
  let cursor = 0;
  let lastLog = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const r = await fn(items[idx], idx);
      results[idx] = r;
      const completed = results.filter(Boolean).length;
      if (completed - lastLog >= 5 || completed === items.length) {
        lastLog = completed;
        process.stdout.write(`  gemini ${completed}/${items.length}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  console.log("");
  return results;
}

function summarize(products, existing) {
  const allowedSet = new Set(BRONZE_SNAKE_CANONICAL_COLORS.map(c => c.toLowerCase()));
  let metafieldSet = 0;
  let metafieldUnknown = []; // metafield value not in canonical list
  let alreadyHasCanonical = 0;
  let needsGemini = [];
  for (const p of products) {
    if (p.metafieldColor) {
      if (allowedSet.has(p.metafieldColor.toLowerCase())) metafieldSet++;
      else metafieldUnknown.push(p);
      continue;
    }
    if (existing.get(p.id)) {
      alreadyHasCanonical++;
      continue;
    }
    needsGemini.push(p);
  }
  return { metafieldSet, metafieldUnknown, alreadyHasCanonical, needsGemini };
}

async function main() {
  const token = await fetchAccessToken();
  const client = new GraphQLClient(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
  );

  console.log(`Mode: ${APPLY ? "APPLY (will write to Neo4j)" : "DRY-RUN"}`);
  console.log(`Gemini fallback: ${USE_GEMINI ? "ON" : "OFF (use --gemini to enable)"}`);
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
    if (APPLY) {
      console.log("Ensuring Neo4j index…");
      await ensureIndex(session);
    }

    console.log("Fetching existing canonicalColor values from Neo4j…");
    const existing = await fetchExistingCanonicalColors(session);
    console.log(`  ✓ ${existing.size} products in Neo4j for ${SHOP}\n`);

    const summary = summarize(products, existing);
    console.log(`Plan:`);
    console.log(`  ${summary.metafieldSet} products → set from Shopify metafield`);
    console.log(`  ${summary.metafieldUnknown.length} products have an unknown metafield value (will use as-is but flag)`);
    console.log(`  ${summary.alreadyHasCanonical} products already have a canonicalColor in Neo4j (skip)`);
    console.log(`  ${summary.needsGemini.length} products missing metafield + missing Neo4j value → ${USE_GEMINI ? "GEMINI" : "skip (no --gemini)"}\n`);

    if (summary.metafieldUnknown.length) {
      console.log(`Sample of unknown metafield values (first 10):`);
      for (const p of summary.metafieldUnknown.slice(0, 10)) {
        console.log(`  - ${p.handle}: "${p.metafieldColor}"`);
      }
      console.log("");
    }

    // Build update list from metafields.
    const updates = [];
    for (const p of products) {
      if (p.metafieldColor) updates.push({ id: p.id, color: p.metafieldColor, source: "metafield" });
    }

    // Gemini fallback for products with no metafield + no existing Neo4j value.
    let geminiUpdates = [];
    if (USE_GEMINI && summary.needsGemini.length) {
      const withImages = summary.needsGemini.filter(p => p.imageUrl);
      const withoutImages = summary.needsGemini.filter(p => !p.imageUrl);
      console.log(`Running Gemini on ${withImages.length} products (${withoutImages.length} skipped — no image)…`);

      const results = await detectWithConcurrency(withImages, GEMINI_CONCURRENCY, async (p) => {
        const r = await detectCanonicalColor({ title: p.title, imageUrl: p.imageUrl });
        return { ...p, gemini: r };
      });

      const samples = [];
      for (const r of results) {
        if (r?.gemini?.color) {
          geminiUpdates.push({ id: r.id, color: r.gemini.color, source: "gemini" });
          if (samples.length < 15) samples.push(`  ${r.handle.padEnd(45)} → ${r.gemini.color}  (${r.gemini.reason || ""})`);
        }
      }
      console.log(`  ✓ Gemini picked colors for ${geminiUpdates.length}/${withImages.length} products`);
      if (samples.length) {
        console.log(`\nSample Gemini picks:`);
        for (const s of samples) console.log(s);
      }
      updates.push(...geminiUpdates);
    }

    console.log(`\nTotal updates queued: ${updates.length} (metafield: ${updates.length - geminiUpdates.length}, gemini: ${geminiUpdates.length})`);

    if (!APPLY) {
      console.log(`\n[DRY-RUN] Would write ${updates.length} canonicalColor values to Neo4j.`);
      console.log(`Run with --apply to commit.`);
      return;
    }

    console.log(`\nWriting to Neo4j…`);
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
