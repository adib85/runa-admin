#!/usr/bin/env node

/**
 * Sync Bronze Snake "Ask AI Options" → Shopify product metafield
 *
 * For each Bronze Snake product:
 *   1. Reads the dedicated Ask-AI cache item from DynamoDB at key
 *      `<storeId>_userOptions_<handle>_<lang>` and extracts
 *      `data.userOptions` — an array of suggestion strings shown as
 *      chips on the PDP. The cache item is filled by
 *      `sync-lambda-ask-ai-options.js`, which calls the AI_STYLIST_URL
 *      Lambda with `language=en` so the Lambda's own cache write lands
 *      at the expected key (the Lambda defaults to `language=ro` if
 *      omitted). The generator also writes the cache itself as a safety
 *      net for the `--skip-caching` path.
 *   2. Sets that array on the source product's `runa.ask_ai_options`
 *      metafield (type: json) via the Shopify Admin GraphQL
 *      `metafieldsSet` mutation.
 *   3. Stamps `ask_ai_metafield_synced_at` in Neo4j so we can resume.
 *
 * The PDP Liquid block reads this metafield as:
 *   {%- assign runa_ask = product.metafields.runa.ask_ai_options.value -%}
 *   askAiOptions: {{ runa_ask | json }}
 * so populating it lets the storefront render the chips without a
 * round-trip to the Lambda.
 *
 * Read-only on Neo4j by default; only writes a small timestamp on success.
 * Read-only on Shopify when --dry-run is set (we still read existing
 * metafields and the cache, but never call metafieldsSet).
 *
 * Usage:
 *   node apps/api/src/scripts/sync-bronzesnake-ask-ai-metafields.js [shop-domain] [options]
 *
 * Options:
 *   --dry-run             Don't write to Shopify or Neo4j, just report.
 *   --handle <handle>     Process a single product by handle.
 *   --missing             Only products that don't have ask_ai_metafield_synced_at yet.
 *   --recent              Only products whose source updated_at is in the recent window.
 *   --hours <n>           Hours window for --recent (default: 48).
 *   --force               Update even if the existing metafield value matches.
 *   --max <n>             Cap number of products processed in this run.
 *   --start <n>           Skip the first N matched products (offset).
 *   --concurrency <n>     Parallel Shopify writes (default: 5).
 *   --delay <ms>          Pause between writes in ms (default: 200).
 *   --language <code>     Cache language suffix to read (default: en).
 *   --max-options <n>     Cap how many ask-ai chips we publish per product (default: 6).
 *
 * Examples (set $SHOP_TOKEN to the Bronze Snake admin token):
 *
 *   # Single product, DRY RUN
 *   SHOP_TOKEN=shpat_xxx node apps/api/src/scripts/sync-bronzesnake-ask-ai-metafields.js \
 *     bronze-snake-1.myshopify.com --handle hallie-shirt-chocolate --dry-run
 *
 *   # All products missing the metafield
 *   SHOP_TOKEN=shpat_xxx node apps/api/src/scripts/sync-bronzesnake-ask-ai-metafields.js \
 *     bronze-snake-1.myshopify.com --missing --concurrency 5
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import AWS from "aws-sdk";
import { GraphQLClient, gql } from "graphql-request";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

// ─── Constants ───────────────────────────────────────────────────────

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const DEFAULT_SHOP   = "bronze-snake-1.myshopify.com";
const SHOPIFY_API    = "2025-10";
const METAFIELD_NS   = "runa";
const METAFIELD_KEY  = "ask_ai_options";
const METAFIELD_TYPE = "json";

// ─── CLI parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const next = args[i + 1];
    if (next && !next.startsWith("--")) i++;
    continue;
  }
  positional.push(a);
}

const SHOP_DOMAIN   = positional[0] || process.env.SHOP_DOMAIN || DEFAULT_SHOP;
let   ACCESS_TOKEN  = process.env.SHOP_TOKEN || process.env.ACCESS_TOKEN || null;

const DRY_RUN       = flag("dry-run");
const SINGLE_HANDLE = opt("handle");
const MISSING_ONLY  = flag("missing");
const RECENT_ONLY   = flag("recent");
const RECENT_HOURS  = parseInt(opt("hours", "48"), 10);
const FORCE         = flag("force");
const MAX_PRODUCTS  = opt("max") ? parseInt(opt("max"), 10) : null;
const START_FROM    = parseInt(opt("start", "0"), 10);
const CONCURRENCY   = Math.max(1, parseInt(opt("concurrency", "5"), 10));
const DELAY_MS      = Math.max(0, parseInt(opt("delay", "200"), 10));
const LANGUAGE      = opt("language", "en");
const MAX_OPTIONS   = Math.max(1, parseInt(opt("max-options", "6"), 10));

// ─── AWS / DynamoDB ──────────────────────────────────────────────────

AWS.config.update({ region: AWS_REGION });
const dynamodb     = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE  = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── Neo4j helpers ───────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function fetchProducts() {
  const driver = getDriver();
  const session = driver.session();
  try {
    if (SINGLE_HANDLE) {
      const r = await session.run(
        `MATCH (p:Product {storeId: $storeId, handle: $handle})
         RETURN p.id AS id, p.title AS title, p.handle AS handle`,
        { storeId: SHOP_DOMAIN, handle: SINGLE_HANDLE }
      );
      return r.records.map(rec => ({
        id: rec.get("id"),
        title: rec.get("title"),
        handle: rec.get("handle"),
      }));
    }

    const recentFilter  = RECENT_ONLY  ? `AND p.updated_at IS NOT NULL AND datetime(p.updated_at) >= datetime() - duration('PT${RECENT_HOURS}H')` : "";
    const missingFilter = MISSING_ONLY ? `AND p.ask_ai_metafield_synced_at IS NULL` : "";

    const r = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${recentFilter}
         ${missingFilter}
       RETURN p.id AS id, p.title AS title, p.handle AS handle
       ORDER BY p.updated_at DESC`,
      { storeId: SHOP_DOMAIN }
    );
    return r.records.map(rec => ({
      id: rec.get("id"),
      title: rec.get("title"),
      handle: rec.get("handle"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function stampSyncedAt(productId, options) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.ask_ai_metafield_synced_at = $syncedAt,
           p.ask_ai_metafield_count     = $count
       RETURN p.id AS id`,
      { productId, storeId: SHOP_DOMAIN, syncedAt: now, count: neo4j.int(options.length) }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── DynamoDB helpers ────────────────────────────────────────────────

function buildAskAiCacheKey(handle, language = LANGUAGE) {
  return `${SHOP_DOMAIN.toLowerCase()}_userOptions_${String(handle).toLowerCase()}_${language}`;
}

async function readUserOptionsFromCache(handle) {
  const id = buildAskAiCacheKey(handle);
  const res = await dynamodb.get({ TableName: CACHE_TABLE, Key: { id } }).promise();
  if (!res.Item) return { cacheId: id, found: false, options: [] };
  // Generator writes `{ data: { userOptions: [...] } }`; fall back to a
  // top-level `userOptions` for safety in case shape ever changes.
  const raw = res.Item?.data?.userOptions ?? res.Item?.userOptions;
  const options = Array.isArray(raw) ? raw : [];
  return { cacheId: id, found: true, options };
}

// ─── Shopify helpers ─────────────────────────────────────────────────

async function fetchAccessTokenFromDB(shop) {
  const res = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${shop}`);
  const data = await res.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No accessToken found in Lambda DB for shop "${shop}"`);
  return token;
}

let shopify;

const READ_METAFIELD_BY_HANDLE = gql`
  query productByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      metafield(namespace: "${METAFIELD_NS}", key: "${METAFIELD_KEY}") {
        id
        type
        value
      }
    }
  }
`;

const METAFIELDS_SET = gql`
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key type value }
      userErrors { field message code }
    }
  }
`;

async function readShopifyMetafield(handle) {
  const r = await shopify.request(READ_METAFIELD_BY_HANDLE, { handle });
  return r?.productByHandle || null;
}

async function setAskAiMetafield(productGid, options, { maxRetries = 3 } = {}) {
  const input = [{
    ownerId: productGid,
    namespace: METAFIELD_NS,
    key: METAFIELD_KEY,
    type: METAFIELD_TYPE,
    value: JSON.stringify(options),
  }];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await shopify.request(METAFIELDS_SET, { metafields: input });
      const errs = r?.metafieldsSet?.userErrors || [];
      if (errs.length) {
        throw new Error(errs.map(e => `${(e.field || []).join(".")}: ${e.message}${e.code ? ` (${e.code})` : ""}`).join(" | "));
      }
      return r.metafieldsSet.metafields[0] || null;
    } catch (e) {
      const msg = e.message || "";
      const transient = /5\d\d|throttl|timeout|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(msg);
      if (transient && attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 500);
        console.log(`        retry in ${backoff}ms (attempt ${attempt}/${maxRetries}): ${msg}`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
}

// ─── Build new metafield value from cache ────────────────────────────

function normaliseOptions(rawOptions) {
  const seen = new Set();
  const out = [];
  for (const o of rawOptions || []) {
    if (typeof o !== "string") continue;
    const trimmed = o.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function jsonEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// ─── Per-product processor ───────────────────────────────────────────

async function processProduct(product, idx, total, stats) {
  const tag = `[${idx + 1}/${total}] ${product.handle}`;
  try {
    const cache = await readUserOptionsFromCache(product.handle);
    if (!cache.found) {
      console.log(`${tag}  SKIP — no cache (${cache.cacheId})`);
      stats.noCache++;
      return;
    }
    const options = normaliseOptions(cache.options);
    if (options.length === 0) {
      console.log(`${tag}  SKIP — cache has no userOptions array`);
      stats.noOptions++;
      return;
    }

    let existingValue = null;
    let existingMeta = null;
    try {
      const live = await readShopifyMetafield(product.handle);
      if (live?.metafield?.value) {
        existingMeta = live.metafield;
        try { existingValue = JSON.parse(live.metafield.value); } catch { existingValue = null; }
      }
    } catch (e) {
      console.log(`${tag}  WARN — could not read existing metafield: ${e.message}`);
    }

    const same = jsonEqual(existingValue, options);
    if (same && !FORCE) {
      console.log(`${tag}  unchanged (${options.length} options) — skip`);
      stats.unchanged++;
      return;
    }

    if (DRY_RUN) {
      const wasN = Array.isArray(existingValue) ? existingValue.length : 0;
      console.log(`${tag}  DRY-RUN would write ${options.length} options (was ${wasN})`);
      console.log(`        first: ${JSON.stringify(options[0])}`);
      stats.wouldUpdate++;
      return;
    }

    const productGid = toGid(product.id);
    await setAskAiMetafield(productGid, options);
    await stampSyncedAt(product.id, options);
    const wasN = Array.isArray(existingValue) ? existingValue.length : 0;
    console.log(`${tag}  WROTE ${options.length} options${existingMeta ? ` (was ${wasN})` : ""}`);
    stats.updated++;
  } catch (e) {
    console.error(`${tag}  ERROR — ${e.message}`);
    stats.errors++;
  } finally {
    if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }
}

function toGid(rawId) {
  if (rawId == null) return null;
  const s = String(rawId);
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Product/${s}`;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  if (!ACCESS_TOKEN) {
    console.log(`[auth] No SHOP_TOKEN env var — fetching access token from Lambda DB for ${SHOP_DOMAIN}...`);
    ACCESS_TOKEN = await fetchAccessTokenFromDB(SHOP_DOMAIN);
  }

  shopify = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API}/graphql.json`, {
    headers: {
      "X-Shopify-Access-Token": ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  });

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Sync Ask-AI Options → Shopify metafield`);
  console.log(`  Shop:        ${SHOP_DOMAIN}`);
  console.log(`  Metafield:   ${METAFIELD_NS}.${METAFIELD_KEY} (${METAFIELD_TYPE})`);
  console.log(`  Mode:        ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  Filter:      ${SINGLE_HANDLE ? `handle="${SINGLE_HANDLE}"` : MISSING_ONLY ? "MISSING ask_ai_metafield_synced_at" : RECENT_ONLY ? `RECENT (last ${RECENT_HOURS}h)` : "ALL Bronze Snake products"}`);
  console.log(`  Cache lang:  ${LANGUAGE}`);
  console.log(`  Max chips:   ${MAX_OPTIONS} per product`);
  console.log(`  Concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms`);
  if (MAX_PRODUCTS) console.log(`  Cap:         ${MAX_PRODUCTS} products`);
  if (START_FROM)   console.log(`  Start from:  offset ${START_FROM}`);
  if (FORCE)        console.log(`  Force:       overwrite even if metafield matches`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Fetching products from Neo4j...`);
  let products = await fetchProducts();
  console.log(`    Found ${products.length} candidate products`);

  if (START_FROM > 0)   products = products.slice(START_FROM);
  if (MAX_PRODUCTS)     products = products.slice(0, MAX_PRODUCTS);
  console.log(`    Processing ${products.length} products\n`);

  if (products.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const stats = { unchanged: 0, updated: 0, wouldUpdate: 0, noCache: 0, noOptions: 0, errors: 0 };
  const total = products.length;

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= products.length) return;
      await processProduct(products[i], i, total, stats);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`    Processed:        ${total}`);
  console.log(`    Updated:          ${stats.updated}`);
  console.log(`    Would update:     ${stats.wouldUpdate}  (dry-run)`);
  console.log(`    Unchanged:        ${stats.unchanged}`);
  console.log(`    No cache:         ${stats.noCache}`);
  console.log(`    No userOptions:   ${stats.noOptions}`);
  console.log(`    Errors:           ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
