#!/usr/bin/env node

/**
 * Bronze Snake — list every color used across the catalog.
 *
 * Reads the canonical color metafield `customAttributes.colour`
 * (single_line_text_field) — this is the same field the storefront uses to
 * power its `filter.p.m.customAttributes.colour` filter, so the resulting
 * list matches what shoppers see on bronzesnake.com (~33 colors instead of
 * the 330 raw option values).
 *
 * Also captures the raw "Color" option values as a fallback so we can spot
 * products missing the canonical metafield.
 *
 * Aggregates:
 *   - globally (with product counts, sorted by frequency)
 *   - per productType (the natural "category")
 *
 * Output: prints a summary to stdout and writes the full JSON to
 *   ./bronzesnake-colors.json
 *
 * Usage:
 *   node apps/api/src/scripts/list-bronzesnake-colors.js
 *   node apps/api/src/scripts/list-bronzesnake-colors.js --token shpat_xxxx
 *   node apps/api/src/scripts/list-bronzesnake-colors.js --out /tmp/colors.json
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { GraphQLClient, gql } from "graphql-request";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL =
  "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const API_VERSION = "2024-10";
const PAGE_SIZE = 250;

const args = process.argv.slice(2);
const tokenIdx = args.indexOf("--token");
const outIdx = args.indexOf("--out");
const OUT_PATH = outIdx !== -1 ? args[outIdx + 1] : path.resolve(process.cwd(), "bronzesnake-colors.json");

const COLOR_OPTION_NAMES = new Set(["color", "colour", "culoare"]);

const PRODUCTS_QUERY = gql`
  query ($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          productType
          options { name values }
          canonicalColor: metafield(namespace: "customAttributes", key: "colour") { value }
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

async function fetchAllProducts(client) {
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
        productType: n.productType || "(uncategorized)",
        options: n.options || [],
        canonicalColor: n.canonicalColor?.value || null,
      });
    }
    hasNext = res.products.pageInfo.hasNextPage;
    cursor = res.products.pageInfo.endCursor;
    process.stdout.write(`  fetched ${products.length}\r`);
  }
  console.log(`  ✓ Fetched ${products.length} products\n`);
  return products;
}

function normalizeColor(v) {
  return String(v || "").trim();
}

function colorKey(v) {
  return normalizeColor(v).toLowerCase();
}

function extractCanonicalColor(product) {
  const v = normalizeColor(product.canonicalColor);
  return v || null;
}

function extractRawOptionColors(product) {
  const opt = (product.options || []).find(o => COLOR_OPTION_NAMES.has(String(o.name || "").toLowerCase()));
  if (!opt) return [];
  return (opt.values || []).map(normalizeColor).filter(Boolean);
}

function aggregate(products) {
  // Canonical (storefront filter source) — Map<lowercaseColor, { display, productIds: Set }>
  const canonicalGlobal = new Map();
  // Map<productType, Map<lowercaseColor, { display, productIds: Set }>>
  const canonicalByType = new Map();
  // Raw option values for products missing the canonical metafield.
  const rawGlobal = new Map();
  const missingCanonical = []; // [{ id, handle, title, productType, rawColors }]

  let productsWithCanonical = 0;
  let productsWithRawOnly = 0;
  let productsWithoutAny = 0;

  for (const p of products) {
    const canonical = extractCanonicalColor(p);
    const raw = extractRawOptionColors(p);

    if (canonical) {
      productsWithCanonical++;
      const k = colorKey(canonical);
      if (!canonicalGlobal.has(k)) canonicalGlobal.set(k, { display: canonical, productIds: new Set() });
      canonicalGlobal.get(k).productIds.add(p.id);

      if (!canonicalByType.has(p.productType)) canonicalByType.set(p.productType, new Map());
      const tm = canonicalByType.get(p.productType);
      if (!tm.has(k)) tm.set(k, { display: canonical, productIds: new Set() });
      tm.get(k).productIds.add(p.id);
    } else if (raw.length) {
      productsWithRawOnly++;
      missingCanonical.push({ id: p.id, handle: p.handle, title: p.title, productType: p.productType, rawColors: raw });
    } else {
      productsWithoutAny++;
    }

    for (const r of raw) {
      const k = colorKey(r);
      if (!k) continue;
      if (!rawGlobal.has(k)) rawGlobal.set(k, { display: r, productIds: new Set() });
      rawGlobal.get(k).productIds.add(p.id);
    }
  }

  return {
    canonicalGlobal,
    canonicalByType,
    rawGlobal,
    missingCanonical,
    productsWithCanonical,
    productsWithRawOnly,
    productsWithoutAny,
  };
}

function sortedList(map) {
  return [...map.entries()]
    .map(([key, v]) => ({ color: v.display, key, productCount: v.productIds.size }))
    .sort((a, b) => b.productCount - a.productCount || a.color.localeCompare(b.color));
}

function printSummary(agg) {
  const canonicalList = sortedList(agg.canonicalGlobal);
  const rawList = sortedList(agg.rawGlobal);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Products with canonical color metafield: ${agg.productsWithCanonical}`);
  console.log(`Products with raw option color only:     ${agg.productsWithRawOnly}`);
  console.log(`Products with no color at all:           ${agg.productsWithoutAny}`);
  console.log(`Unique canonical colors:                 ${canonicalList.length}`);
  console.log(`Unique raw option-color values:          ${rawList.length}`);
  console.log(`──────────────────────────────────────────────\n`);

  console.log(`CANONICAL COLORS (customAttributes.colour — what powers the storefront filter):`);
  for (const { color, productCount } of canonicalList) {
    console.log(`  ${String(productCount).padStart(4)}  ${color}`);
  }

  console.log(`\nCanonical colors per productType:`);
  const types = [...agg.canonicalByType.keys()].sort();
  for (const t of types) {
    const list = sortedList(agg.canonicalByType.get(t));
    console.log(`\n  [${t}]  ${list.length} colors`);
    for (const { color, productCount } of list) {
      console.log(`    ${String(productCount).padStart(4)}  ${color}`);
    }
  }

  if (agg.missingCanonical.length) {
    console.log(`\n⚠  ${agg.missingCanonical.length} products have a Color option but no customAttributes.colour metafield.`);
    console.log(`   First 10 examples:`);
    for (const m of agg.missingCanonical.slice(0, 10)) {
      console.log(`     - ${m.handle}  [${m.productType}]  raw: ${m.rawColors.join(", ")}`);
    }
  }
}

function buildJsonOutput(agg) {
  const canonicalList = sortedList(agg.canonicalGlobal);
  const perType = {};
  for (const [t, m] of agg.canonicalByType.entries()) {
    perType[t] = sortedList(m);
  }
  return {
    shop: SHOP,
    generatedAt: new Date().toISOString(),
    source: "metafield customAttributes.colour (single_line_text_field)",
    stats: {
      productsWithCanonical: agg.productsWithCanonical,
      productsWithRawOnly: agg.productsWithRawOnly,
      productsWithoutAny: agg.productsWithoutAny,
      uniqueCanonicalColors: canonicalList.length,
      uniqueRawOptionColors: agg.rawGlobal.size,
      productTypes: Object.keys(perType).length,
    },
    canonicalColors: canonicalList,
    canonicalColorsByProductType: perType,
    rawOptionColors: sortedList(agg.rawGlobal),
    productsMissingCanonical: agg.missingCanonical,
  };
}

async function main() {
  const token = await fetchAccessToken();
  const client = new GraphQLClient(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
  );

  console.log(`Fetching products from ${SHOP}…`);
  const products = await fetchAllProducts(client);

  const agg = aggregate(products);
  printSummary(agg);

  const out = buildJsonOutput(agg);
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote ${OUT_PATH}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
