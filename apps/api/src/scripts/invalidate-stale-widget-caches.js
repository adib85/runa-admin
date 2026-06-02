#!/usr/bin/env node

/**
 * Invalidate stale widget caches so the next sync rebuilds them.
 *
 * Background: when the cache-builder Lambdas return an empty result
 * (Neo4j has no candidates / Gemini selects 0 items), the empty payload
 * still gets cached in DynamoDB and the cache-builder scripts still
 * stamp `*_updated_at` on the product node. After that, the metafield
 * writers report "no cache" or "cache has no usable ids" and `--missing`
 * mode permanently skips the product.
 *
 * This script finds every Bronze Snake product where the DynamoDB
 * cache for a given widget is either MISSING or EMPTY, deletes the
 * cache item (if any), and clears both Neo4j stamps so `--missing`
 * mode will retry on the next run.
 *
 * Three widgets supported:
 *   - similar  → similar_products  (cache key: <shop>_similar_products_<handle>_<lang>)
 *                stamps: similar_product_updated_at, similar_metafield_synced_at
 *   - ctl      → complete_the_look (cache key: <shop>_<handle>_<lang>)
 *                stamps: complete_the_look_updated_at, ctl_metafield_synced_at
 *   - ask-ai   → ask_ai_options    (cache key: <shop>_userOptions_<handle>_<lang>)
 *                stamps: ask_ai_options_updated_at, ask_ai_metafield_synced_at
 *
 * Usage:
 *   node apps/api/src/scripts/invalidate-stale-widget-caches.js [shop-domain] [options]
 *
 * Options:
 *   --widget <w>          similar | ctl | ask-ai | all   (default: all)
 *   --language <code>     Cache language suffix (default: en)
 *   --handle <handle>     Restrict to a single product handle
 *   --handles-file <path> Restrict to handles listed in a file (one per line,
 *                         blank lines and #-comments ignored). When set, the
 *                         Neo4j stamp filter is skipped — the script trusts
 *                         the file as the universe of products to inspect.
 *   --apply               Actually delete cache + clear stamps (default: dry-run)
 *   --concurrency <n>     Parallel cache reads (default: 10)
 *
 * Examples:
 *   # Preview what would be invalidated across all 3 widgets
 *   node apps/api/src/scripts/invalidate-stale-widget-caches.js
 *
 *   # Actually do it
 *   node apps/api/src/scripts/invalidate-stale-widget-caches.js --apply
 *
 *   # Just similar-products, just one handle
 *   node apps/api/src/scripts/invalidate-stale-widget-caches.js \
 *     --widget similar --handle roman-zip-hoodie-black --apply
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import AWS from "aws-sdk";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

// ─── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
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

const SHOP_DOMAIN  = positional[0] || process.env.SHOP_DOMAIN || "bronze-snake-1.myshopify.com";
const WIDGET       = (opt("widget", "all") || "all").toLowerCase();
const LANGUAGE     = opt("language", "en");
const SINGLE_HANDLE = opt("handle");
const APPLY        = flag("apply");
const CONCURRENCY  = Math.max(1, parseInt(opt("concurrency", "10"), 10));

const VALID_WIDGETS = ["similar", "ctl", "ask-ai", "all"];
if (!VALID_WIDGETS.includes(WIDGET)) {
  console.error(`Invalid --widget "${WIDGET}". Must be one of: ${VALID_WIDGETS.join(", ")}`);
  process.exit(1);
}

// ─── AWS / Neo4j ─────────────────────────────────────────────────────

AWS.config.update({ region: AWS_REGION });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

// ─── Widget specs ────────────────────────────────────────────────────

const WIDGETS = {
  similar: {
    label: "Similar Products",
    cacheKey: (shop, handle, lang) => `${shop.toLowerCase()}_similar_products_${handle.toLowerCase()}_${lang}`,
    // Whether the cache payload is "usable"
    isCacheUsable: (item) => Array.isArray(item?.data?.products) && item.data.products.length > 0,
    // Neo4j filter: products that have at least one of these stamps set
    neo4jStampFields: ["similar_product_updated_at", "similar_metafield_synced_at", "similar_metafield_count"],
  },
  ctl: {
    label: "Complete The Look",
    cacheKey: (shop, handle, lang) => `${shop.toLowerCase()}_${handle.toLowerCase()}_${lang}`,
    isCacheUsable: (item) => Array.isArray(item?.data?.outfits) && item.data.outfits.length > 0,
    neo4jStampFields: ["complete_the_look_updated_at", "ctl_metafield_synced_at", "ctl_metafield_count"],
  },
  "ask-ai": {
    label: "Ask AI Options",
    cacheKey: (shop, handle, lang) => `${shop.toLowerCase()}_userOptions_${handle.toLowerCase()}_${lang}`,
    isCacheUsable: (item) => Array.isArray(item?.data?.userOptions) && item.data.userOptions.length > 0,
    neo4jStampFields: ["ask_ai_options_updated_at", "ask_ai_metafield_synced_at", "ask_ai_options_count"],
  },
};

// ─── Neo4j helpers ───────────────────────────────────────────────────

async function fetchCandidateProducts(stampFields) {
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
        id: rec.get("id"), title: rec.get("title"), handle: rec.get("handle"),
      }));
    }

    // Find products that have ANY of the stamps set — those are the
    // ones we previously processed, so any with a missing/empty cache
    // are the stuck ones we want to invalidate.
    const stampOr = stampFields.map(f => `p.${f} IS NOT NULL`).join(" OR ");
    const r = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
         AND (${stampOr})
       RETURN p.id AS id, p.title AS title, p.handle AS handle
       ORDER BY p.updated_at DESC`,
      { storeId: SHOP_DOMAIN }
    );
    return r.records.map(rec => ({
      id: rec.get("id"), title: rec.get("title"), handle: rec.get("handle"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function clearStamps(productId, stampFields) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const removes = stampFields.map(f => `p.${f}`).join(", ");
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       REMOVE ${removes}`,
      { productId, storeId: SHOP_DOMAIN }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── DynamoDB helpers ────────────────────────────────────────────────

async function readCache(cacheId) {
  const res = await dynamodb.get({ TableName: CACHE_TABLE, Key: { id: cacheId } }).promise();
  return res.Item || null;
}

async function deleteCache(cacheId) {
  await dynamodb.delete({ TableName: CACHE_TABLE, Key: { id: cacheId } }).promise();
}

// ─── Per-widget invalidator ──────────────────────────────────────────

async function classifyProduct(product, widget) {
  const cacheId = widget.cacheKey(SHOP_DOMAIN, product.handle, LANGUAGE);
  const item = await readCache(cacheId);
  if (!item) return { product, cacheId, state: "missing", hadCache: false };
  if (!widget.isCacheUsable(item)) return { product, cacheId, state: "empty", hadCache: true };
  return { product, cacheId, state: "valid", hadCache: true };
}

async function processWidget(name) {
  const widget = WIDGETS[name];
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  ${widget.label}`);
  console.log(`  Shop:        ${SHOP_DOMAIN}`);
  console.log(`  Language:    ${LANGUAGE}`);
  console.log(`  Mode:        ${APPLY ? "APPLY (will delete + clear stamps)" : "DRY RUN"}`);
  if (SINGLE_HANDLE) console.log(`  Handle:      ${SINGLE_HANDLE}`);
  console.log(`═══════════════════════════════════════════════════════════`);

  const products = await fetchCandidateProducts(widget.neo4jStampFields);
  console.log(`  Candidates (have at least one stamp set): ${products.length}`);

  if (products.length === 0) {
    console.log("  Nothing to inspect.");
    return { invalidated: 0, missing: 0, empty: 0, valid: 0 };
  }

  // Classify in parallel batches
  const classified = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= products.length) return;
      try {
        classified.push(await classifyProduct(products[i], widget));
      } catch (e) {
        console.error(`  [${products[i].handle}] classify error: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const missing = classified.filter(c => c.state === "missing");
  const empty   = classified.filter(c => c.state === "empty");
  const valid   = classified.filter(c => c.state === "valid");

  console.log(`  → valid:   ${valid.length}`);
  console.log(`  → missing: ${missing.length}  (cache item not present, but stamp says we did it)`);
  console.log(`  → empty:   ${empty.length}  (cache item present but no usable data)`);

  const targets = [...missing, ...empty];
  if (targets.length === 0) {
    console.log("  Nothing to invalidate.");
    return { invalidated: 0, missing: missing.length, empty: empty.length, valid: valid.length };
  }

  console.log(`\n  Will invalidate ${targets.length} product${targets.length === 1 ? "" : "s"}:`);
  for (const t of targets.slice(0, 20)) {
    console.log(`    [${t.state.padEnd(7)}] ${t.product.handle}  (${t.cacheId})`);
  }
  if (targets.length > 20) console.log(`    … +${targets.length - 20} more`);

  if (!APPLY) {
    console.log(`\n  (dry-run — pass --apply to actually invalidate)`);
    return { invalidated: 0, missing: missing.length, empty: empty.length, valid: valid.length };
  }

  let invalidated = 0;
  let errors = 0;
  cursor = 0;
  async function applyWorker() {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) return;
      const t = targets[i];
      try {
        if (t.hadCache) await deleteCache(t.cacheId);
        await clearStamps(t.product.id, widget.neo4jStampFields);
        invalidated++;
      } catch (e) {
        errors++;
        console.error(`  [${t.product.handle}] invalidate error: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => applyWorker()));

  console.log(`\n  Invalidated: ${invalidated}  Errors: ${errors}`);
  return { invalidated, missing: missing.length, empty: empty.length, valid: valid.length, errors };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const widgetsToRun = WIDGET === "all" ? ["similar", "ctl", "ask-ai"] : [WIDGET];

  const summary = {};
  for (const name of widgetsToRun) {
    summary[name] = await processWidget(name);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY${APPLY ? "" : " (DRY RUN)"}`);
  for (const name of widgetsToRun) {
    const s = summary[name];
    console.log(`  ${WIDGETS[name].label.padEnd(20)}  valid:${s.valid}  missing:${s.missing}  empty:${s.empty}  invalidated:${s.invalidated}${s.errors ? `  errors:${s.errors}` : ""}`);
  }
  console.log(`═══════════════════════════════════════════════════════════`);
  if (!APPLY) console.log(`\nRun again with --apply to actually invalidate.`);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error("\nFatal error:", e); process.exit(1); });
