#!/usr/bin/env node

/**
 * Sync Bronze Snake "Hero Image" → Shopify product metafield
 *
 * For each Bronze Snake product:
 *   1. Reads the AI-selected hero image URL from Neo4j (`p.heroImage`).
 *      Falls back to `p.images[0]` (first product image) if heroImage
 *      is missing.
 *   2. Sets that URL on the source product's `runa.hero_image` metafield
 *      (type: url) via the Shopify Admin GraphQL `metafieldsSet`
 *      mutation.
 *   3. Stamps `hero_image_metafield_synced_at` in Neo4j so we can resume.
 *
 * No DynamoDB cache and no Lambda call — the hero image is already
 * computed by other pipelines (`pick-hero-images.js`,
 * `sync-modular.js`) and stored on the Product node.
 *
 * The PDP Liquid block can read this metafield as:
 *   {%- assign runa_hero_url = product.metafields.runa.hero_image -%}
 *   <img src="{{ runa_hero_url }}" alt="{{ product.title }}" />
 *
 * Usage:
 *   node apps/api/src/scripts/sync-bronzesnake-hero-image-metafields.js [shop-domain] [options]
 *
 * Options:
 *   --dry-run             Don't write to Shopify or Neo4j, just report.
 *   --handle <handle>     Process a single product by handle.
 *   --missing             Only products that don't have hero_image_metafield_synced_at yet.
 *   --recent              Only products whose source updated_at is in the recent window.
 *   --hours <n>           Hours window for --recent (default: 48).
 *   --force               Update even if the existing metafield value matches.
 *   --max <n>             Cap number of products processed in this run.
 *   --start <n>           Skip the first N matched products (offset).
 *   --concurrency <n>     Parallel Shopify writes (default: 5).
 *   --delay <ms>          Pause between writes in ms (default: 200).
 *
 * Examples (set $SHOP_TOKEN to the Bronze Snake admin token):
 *
 *   # Single product, DRY RUN
 *   SHOP_TOKEN=shpat_xxx node apps/api/src/scripts/sync-bronzesnake-hero-image-metafields.js \
 *     bronze-snake-1.myshopify.com --handle hallie-shirt-chocolate --dry-run
 *
 *   # All products missing the metafield
 *   SHOP_TOKEN=shpat_xxx node apps/api/src/scripts/sync-bronzesnake-hero-image-metafields.js \
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
import { GraphQLClient, gql } from "graphql-request";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

// ─── Constants ───────────────────────────────────────────────────────

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const DEFAULT_SHOP   = "bronze-snake-1.myshopify.com";
const SHOPIFY_API    = "2025-10";
const METAFIELD_NS   = "runa";
const METAFIELD_KEY  = "hero_image";
const METAFIELD_TYPE = "url";

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
         RETURN p.id AS id, p.title AS title, p.handle AS handle,
                p.heroImage AS heroImage, p.heroImageIndex AS heroIndex,
                p.images AS images`,
        { storeId: SHOP_DOMAIN, handle: SINGLE_HANDLE }
      );
      return r.records.map(rec => ({
        id: rec.get("id"),
        title: rec.get("title"),
        handle: rec.get("handle"),
        heroImage: rec.get("heroImage"),
        heroIndex: rec.get("heroIndex"),
        images: rec.get("images") || [],
      }));
    }

    const recentFilter  = RECENT_ONLY  ? `AND p.updated_at IS NOT NULL AND datetime(p.updated_at) >= datetime() - duration('PT${RECENT_HOURS}H')` : "";
    const missingFilter = MISSING_ONLY ? `AND p.hero_image_metafield_synced_at IS NULL` : "";

    const r = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         ${recentFilter}
         ${missingFilter}
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.heroImage AS heroImage, p.heroImageIndex AS heroIndex,
              p.images AS images
       ORDER BY p.updated_at DESC`,
      { storeId: SHOP_DOMAIN }
    );
    return r.records.map(rec => ({
      id: rec.get("id"),
      title: rec.get("title"),
      handle: rec.get("handle"),
      heroImage: rec.get("heroImage"),
      heroIndex: rec.get("heroIndex"),
      images: rec.get("images") || [],
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function stampSyncedAt(productId, source) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const now = new Date().toISOString();
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.hero_image_metafield_synced_at = $syncedAt,
           p.hero_image_metafield_source    = $source
       RETURN p.id AS id`,
      { productId, storeId: SHOP_DOMAIN, syncedAt: now, source }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Hero URL resolver ───────────────────────────────────────────────
//
// Picks the URL we'll write. Source string is stamped to Neo4j so we
// know later whether it was the AI hero or the fallback.

function resolveHeroUrl(product) {
  if (product.heroImage && typeof product.heroImage === "string" && product.heroImage.trim()) {
    return { url: product.heroImage.trim(), source: "heroImage" };
  }
  if (Array.isArray(product.images) && product.images[0] && typeof product.images[0] === "string") {
    return { url: product.images[0].trim(), source: "images[0]" };
  }
  return { url: null, source: null };
}

function normalizeUrl(u) {
  if (!u || typeof u !== "string") return null;
  let s = u.trim();
  // Shopify CDN sometimes returns protocol-relative URLs (//cdn.shopify.com/...)
  if (s.startsWith("//")) s = "https:" + s;
  return s;
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

async function setHeroImageMetafield(productGid, url, { maxRetries = 3 } = {}) {
  const input = [{
    ownerId: productGid,
    namespace: METAFIELD_NS,
    key: METAFIELD_KEY,
    type: METAFIELD_TYPE,
    value: url,
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

function toGid(rawId) {
  if (rawId == null) return null;
  const s = String(rawId);
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Product/${s}`;
}

// ─── Per-product processor ───────────────────────────────────────────

async function processProduct(product, idx, total, stats) {
  const tag = `[${idx + 1}/${total}] ${product.handle}`;
  try {
    const { url: rawUrl, source } = resolveHeroUrl(product);
    const url = normalizeUrl(rawUrl);
    if (!url) {
      console.log(`${tag}  SKIP — no heroImage and no images[0] in Neo4j`);
      stats.noImage++;
      return;
    }

    let existingValue = null;
    let existingMeta = null;
    try {
      const live = await readShopifyMetafield(product.handle);
      if (live?.metafield?.value) {
        existingMeta = live.metafield;
        existingValue = live.metafield.value;
      }
    } catch (e) {
      console.log(`${tag}  WARN — could not read existing metafield: ${e.message}`);
    }

    const same = existingValue === url;
    if (same && !FORCE) {
      console.log(`${tag}  unchanged (${source}) — skip`);
      stats.unchanged++;
      return;
    }

    if (DRY_RUN) {
      const wasNote = existingValue ? `was ${existingValue.slice(0, 80)}…` : "was empty";
      console.log(`${tag}  DRY-RUN would write [${source}] (${wasNote})`);
      console.log(`        new: ${url.slice(0, 100)}${url.length > 100 ? "…" : ""}`);
      stats.wouldUpdate++;
      return;
    }

    const productGid = toGid(product.id);
    await setHeroImageMetafield(productGid, url);
    await stampSyncedAt(product.id, source);
    console.log(`${tag}  WROTE [${source}]${existingMeta ? " (replaced)" : ""}`);
    stats.updated++;
  } catch (e) {
    console.error(`${tag}  ERROR — ${e.message}`);
    stats.errors++;
  } finally {
    if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }
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
  console.log(`  Sync Hero Image → Shopify metafield`);
  console.log(`  Shop:        ${SHOP_DOMAIN}`);
  console.log(`  Metafield:   ${METAFIELD_NS}.${METAFIELD_KEY} (${METAFIELD_TYPE})`);
  console.log(`  Mode:        ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  Filter:      ${SINGLE_HANDLE ? `handle="${SINGLE_HANDLE}"` : MISSING_ONLY ? "MISSING hero_image_metafield_synced_at" : RECENT_ONLY ? `RECENT (last ${RECENT_HOURS}h)` : "ALL Bronze Snake products"}`);
  console.log(`  Concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms`);
  if (MAX_PRODUCTS) console.log(`  Cap:         ${MAX_PRODUCTS} products`);
  if (START_FROM)   console.log(`  Start from:  offset ${START_FROM}`);
  if (FORCE)        console.log(`  Force:       overwrite even if metafield matches`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Fetching products from Neo4j...`);
  let products = await fetchProducts();
  console.log(`    Found ${products.length} candidate products`);

  if (START_FROM > 0) products = products.slice(START_FROM);
  if (MAX_PRODUCTS)   products = products.slice(0, MAX_PRODUCTS);
  console.log(`    Processing ${products.length} products\n`);

  if (products.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const stats = { unchanged: 0, updated: 0, wouldUpdate: 0, noImage: 0, errors: 0 };
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
  console.log(`    Processed:     ${total}`);
  console.log(`    Updated:       ${stats.updated}`);
  console.log(`    Would update:  ${stats.wouldUpdate}  (dry-run)`);
  console.log(`    Unchanged:     ${stats.unchanged}`);
  console.log(`    No image:      ${stats.noImage}`);
  console.log(`    Errors:        ${stats.errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
