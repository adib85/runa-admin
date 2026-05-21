#!/usr/bin/env node

/**
 * Fix TOFF Broken Images (quick targeted refresh)
 *
 * Detects products in Neo4j whose Product.image is currently broken (404 etc.)
 * for the TOFF store, refetches fresh image URLs from the VTEX Search API,
 * updates Product.image / Product.images in Neo4j, and invalidates the
 * Complete-The-Look + Similar-Products cache entries for those handles.
 *
 * Usage:
 *   node apps/api/src/scripts/fix-toff-broken-images.js [--dry-run] [--handles <h1,h2,...>] [--all-images]
 *
 * Options:
 *   --dry-run          Detect + fetch, but do NOT write to Neo4j or DynamoDB
 *   --handles <list>   Comma-separated handles to force-fix (skips auto-detect)
 *   --all-images       Also refresh Product.images[] (otherwise just main image)
 *   --no-cache-bust    Skip per-handle cache invalidation
 *   --no-fanout        Skip referencing-entry (fan-out) cache invalidation
 *
 * The script does TWO levels of cache invalidation:
 *   1. Per-handle bust: deletes the cache entries directly keyed by each
 *      affected product's handle (CTL + Similar + userOptions, en+ro).
 *   2. Fan-out sweep: scans the whole store cache and deletes any entry whose
 *      payload references the affected products by id or handle (e.g. the
 *      product appearing inside someone else's CTL outfit). Includes the
 *      delisted/no-longer-in-VTEX products as well, so widget references to
 *      them get cleared too.
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import neo4j from "neo4j-driver";
import AWS from "aws-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";
import { deleteReferencingCacheEntries } from "./cache-fanout.js";

// ─── Config ──────────────────────────────────────────────────────────

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;
const STORE_ID = `${accountName}.vtexcommercestable.com.br`;
const VTEX_BASE = `https://${accountName}.vtexcommercestable.com.br`;
const VTEX_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
};

AWS.config.update({ region: AWS_REGION });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const DRY_RUN = args.includes("--dry-run");
const ALL_IMAGES = args.includes("--all-images");
const NO_CACHE_BUST = args.includes("--no-cache-bust");
const NO_FANOUT = args.includes("--no-fanout");
const FORCED_HANDLES = argVal("handles");

// ─── Helpers ─────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function head(url, timeoutMs = 10000) {
  if (!url) return 0;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
    return r.status;
  } catch {
    return 0;
  } finally { clearTimeout(t); }
}

async function fetchAllNeo4jProducts() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product) WHERE p.storeId = $storeId
       RETURN p.id AS id, p.handle AS handle, p.title AS title,
              p.image AS image, p.images AS images`,
      { storeId: STORE_ID }
    );
    return r.records.map(x => ({
      id: x.get("id"),
      handle: x.get("handle"),
      title: x.get("title"),
      image: x.get("image"),
      images: x.get("images") || [],
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function detectBroken(products) {
  const broken = [];
  let i = 0, done = 0;
  const CONC = 6;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) {
      const my = i++;
      if (my >= products.length) return;
      const p = products[my];
      const status = await head(p.image);
      done++;
      if (done % 200 === 0) process.stdout.write(`\r  Checked ${done}/${products.length}`);
      if (status !== 200) broken.push({ ...p, status });
    }
  }));
  process.stdout.write(`\r  Checked ${done}/${products.length}\n`);
  return broken;
}

async function fetchVtexProductByHandle(handle) {
  const url = `${VTEX_BASE}/api/catalog_system/pub/products/search/${handle}/p`;
  const r = await fetch(url, { headers: VTEX_HEADERS });
  if (!r.ok) throw new Error(`VTEX ${r.status} for handle ${handle}`);
  const arr = await r.json();
  return arr[0] || null;
}

function extractImagesFromVtex(product) {
  // Mirrors apps/api/src/sync/providers/vtex.js → transformSearchProduct
  const availableItems = (product.items || []).filter(item =>
    item.sellers?.some(seller => seller.commertialOffer?.IsAvailable)
  );
  const mainItem = availableItems[0] || product.items?.[0] || {};
  const images = mainItem.images?.map(img => ({
    src: img.imageUrl,
    alt: img.imageText || img.imageLabel || "",
  })) || [];
  return {
    image: images[0]?.src || null,
    images: images.map(i => i.src),
    mainItemId: mainItem.itemId,
  };
}

async function updateNeo4jImages(productId, image, images) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product {id: $id, storeId: $storeId})
       SET p.image = $image, p.images = $images, p.updated_at = $now
       RETURN p.id AS id`,
      { id: productId, storeId: STORE_ID, image, images, now: new Date().toISOString() }
    );
    return r.records.length > 0;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function bustCachesForHandle(handle, languages = ["en", "ro"]) {
  const ids = [];
  for (const lang of languages) {
    ids.push(`${STORE_ID}_${handle}_${lang}`);
    ids.push(`${STORE_ID.toLowerCase()}_similar_products_${handle.toLowerCase()}_${lang}`);
    ids.push(`${STORE_ID}_userOptions_${handle}_${lang}`);
  }
  const results = await Promise.all(ids.map(id =>
    docClient.delete({ TableName: CACHE_TABLE, Key: { id } }).promise()
      .then(() => ({ id, ok: true }))
      .catch(e => ({ id, ok: false, err: e.message }))
  ));
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Fix TOFF Broken Images`);
  console.log(`  Store:        ${STORE_ID}`);
  console.log(`  Mode:         ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  Cache bust:   ${NO_CACHE_BUST ? "disabled" : "per-handle enabled"}`);
  console.log(`  Fan-out:      ${NO_FANOUT ? "disabled" : "enabled (sweeps referencing entries)"}`);
  console.log(`  Refresh:      ${ALL_IMAGES ? "main + all images[]" : "main image only"}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // ── Step 1: pick targets ──────────────────────────────────────────
  let targets;
  if (FORCED_HANDLES) {
    const wanted = FORCED_HANDLES.split(",").map(h => h.trim()).filter(Boolean);
    console.log(`[1] Using forced handles list (${wanted.length})`);
    const all = await fetchAllNeo4jProducts();
    targets = all.filter(p => wanted.includes(p.handle));
    console.log(`    Matched ${targets.length}/${wanted.length} in Neo4j\n`);
  } else {
    console.log(`[1] Loading all TOFF products from Neo4j...`);
    const all = await fetchAllNeo4jProducts();
    console.log(`    ${all.length} products. Detecting broken main images (concurrency 6)...\n`);
    targets = await detectBroken(all);
    console.log(`\n    Found ${targets.length} products with broken Product.image\n`);
  }

  if (targets.length === 0) {
    console.log("Nothing to fix. Done.");
    return;
  }

  // ── Step 2: refetch from VTEX + update Neo4j ──────────────────────
  console.log(`[2] Refetching from VTEX and updating Neo4j...\n`);

  const fixed = [];
  const stillBad = [];
  const notFoundInVtex = [];

  for (const p of targets) {
    process.stdout.write(`  → ${p.handle}\n`);
    let vtexProduct;
    try {
      vtexProduct = await fetchVtexProductByHandle(p.handle);
    } catch (e) {
      console.log(`     VTEX fetch failed: ${e.message}`);
      stillBad.push({ ...p, reason: `vtex-error: ${e.message}` });
      continue;
    }

    if (!vtexProduct) {
      console.log(`     ✗ Not in VTEX anymore (likely unpublished). Skipping.`);
      notFoundInVtex.push(p);
      continue;
    }

    const fresh = extractImagesFromVtex(vtexProduct);
    if (!fresh.image) {
      console.log(`     ✗ VTEX returned no images for available SKU. Skipping.`);
      stillBad.push({ ...p, reason: "no-images-in-vtex" });
      continue;
    }

    // Verify the fresh URL actually works before writing
    const freshStatus = await head(fresh.image);
    if (freshStatus !== 200) {
      console.log(`     ✗ Fresh URL still ${freshStatus}: ${fresh.image}`);
      stillBad.push({ ...p, reason: `fresh-url-${freshStatus}` });
      continue;
    }

    const newImage = fresh.image;
    const newImages = ALL_IMAGES ? fresh.images : (
      // Replace the broken main image position; keep array length sane
      fresh.images.length > 0 ? fresh.images : [newImage]
    );

    console.log(`     ✓ New main image (${freshStatus}): ${newImage}`);
    if (DRY_RUN) {
      console.log(`     [dry-run] would update Neo4j Product ${p.id}`);
    } else {
      const ok = await updateNeo4jImages(p.id, newImage, newImages);
      console.log(`     ${ok ? "✓ Updated Neo4j" : "✗ Neo4j update returned no rows"}`);
    }

    fixed.push({ ...p, newImage, newImages });
  }

  // ── Step 3: per-handle cache bust ─────────────────────────────────
  if (!NO_CACHE_BUST && !DRY_RUN && fixed.length > 0) {
    console.log(`\n[3] Invalidating per-handle caches for ${fixed.length} fixed handle(s)...\n`);
    for (const p of fixed) {
      const results = await bustCachesForHandle(p.handle);
      const okCount = results.filter(r => r.ok).length;
      console.log(`  ${p.handle}: ${okCount}/${results.length} cache keys deleted`);
    }
  } else if (DRY_RUN) {
    console.log(`\n[3] [dry-run] would invalidate per-handle caches for ${fixed.length} handle(s)`);
  } else if (NO_CACHE_BUST) {
    console.log(`\n[3] Per-handle cache bust skipped (--no-cache-bust)`);
  }

  // ── Step 4: fan-out cache invalidation ────────────────────────────
  // Sweeps every CTL/Similar cache entry whose payload references any of the
  // affected products (fixed OR delisted) and deletes those entries so the
  // Lambda regenerates them with the now-correct image URL (or without the
  // delisted product).
  const fanoutTargets = [...fixed, ...notFoundInVtex];
  const fanoutIds = fanoutTargets.map(p => p.id).filter(Boolean);
  const fanoutHandles = fanoutTargets.map(p => p.handle).filter(Boolean);

  if (!NO_FANOUT && fanoutTargets.length > 0) {
    console.log(`\n[4] Fan-out sweep across ${STORE_ID} cache...`);
    console.log(`    Targets: ${fanoutTargets.length} products (${fixed.length} fixed + ${notFoundInVtex.length} delisted)`);
    console.log(`    IDs:     ${fanoutIds.join(", ")}`);
    let lastTick = Date.now();
    const summary = await deleteReferencingCacheEntries(docClient, {
      storeId: STORE_ID,
      productIds: fanoutIds,
      handles: fanoutHandles,
      cacheTable: CACHE_TABLE,
      dryRun: DRY_RUN,
      onProgress: ({ scanned, matched }) => {
        if (Date.now() - lastTick > 1000) {
          lastTick = Date.now();
          process.stdout.write(`\r    Scanned ${scanned}, matched ${matched}`);
        }
      },
    });
    process.stdout.write(`\r    Scanned ${summary.scanned}, matched ${summary.matched}\n`);

    if (summary.matched > 0) {
      console.log(`\n    Sample matches (first 20):`);
      for (const m of summary.matches.slice(0, 20)) {
        console.log(`      • ${m.id}`);
        console.log(`          ↳ ${m.location}`);
      }
      if (summary.matches.length > 20) {
        console.log(`      …and ${summary.matches.length - 20} more`);
      }
    }

    if (DRY_RUN) {
      console.log(`\n    [dry-run] would delete ${summary.matched} fan-out entries`);
    } else {
      console.log(`\n    Deleted: ${summary.deleted}/${summary.matched}`);
      if (summary.failed > 0) {
        console.log(`    Failed:  ${summary.failed}`);
        summary.failures.slice(0, 5).forEach(f => console.log(`      ✗ ${f.id}: ${f.error}`));
      }
    }
  } else if (NO_FANOUT) {
    console.log(`\n[4] Fan-out sweep skipped (--no-fanout)`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`  ✓ Fixed:                ${fixed.length}`);
  console.log(`  ✗ Not in VTEX:          ${notFoundInVtex.length}`);
  console.log(`  ✗ Still broken:         ${stillBad.length}`);
  if (notFoundInVtex.length) {
    console.log(`\n  Not in VTEX (consider removing from Neo4j):`);
    notFoundInVtex.forEach(p => console.log(`    - ${p.handle}`));
  }
  if (stillBad.length) {
    console.log(`\n  Still broken:`);
    stillBad.forEach(p => console.log(`    - ${p.handle}  (${p.reason})`));
  }
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error("\nFatal error:", e); process.exit(1); });
