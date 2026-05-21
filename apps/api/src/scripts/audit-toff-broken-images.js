#!/usr/bin/env node

/**
 * Audit TOFF Broken Main Images
 *
 * Pulls all TOFF products from Neo4j and HEAD-checks each Product.image
 * to count how many are broken (404 / 5xx / network errors).
 *
 * Usage:
 *   node apps/api/src/scripts/audit-toff-broken-images.js [--limit <n>] [--concurrency <n>] [--check-all-images] [--dump <path>]
 *
 * Options:
 *   --limit <n>          Only check first N products (default: all)
 *   --concurrency <n>    Parallel HEAD requests (default: 30)
 *   --check-all-images   Also HEAD-check Product.images[] (slower; default: only Product.image)
 *   --dump <path>        Write CSV of broken products to <path>
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import neo4j from "neo4j-driver";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const STORE_ID = "toffro.vtexcommercestable.com.br";

const args = process.argv.slice(2);
function argVal(name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const LIMIT = argVal("limit") ? parseInt(argVal("limit"), 10) : null;
const CONCURRENCY = argVal("concurrency") ? parseInt(argVal("concurrency"), 10) : 30;
const CHECK_ALL = args.includes("--check-all-images");
const DUMP_PATH = argVal("dump");

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function fetchAllProducts() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const cypher = `
      MATCH (p:Product)
      WHERE p.storeId = $storeId
      RETURN p.id AS id, p.handle AS handle, p.title AS title,
             p.image AS image, p.images AS images, p.updated_at AS updatedAt
      ORDER BY p.updated_at DESC
      ${LIMIT ? `LIMIT ${LIMIT}` : ""}
    `;
    const result = await session.run(cypher, { storeId: STORE_ID });
    return result.records.map(r => ({
      id: r.get("id"),
      handle: r.get("handle"),
      title: r.get("title"),
      image: r.get("image"),
      images: r.get("images") || [],
      updatedAt: r.get("updatedAt"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function headStatus(url, timeoutMs = 8000) {
  if (!url) return { status: 0, error: "null-url" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
    return { status: r.status };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : e.message.slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  let lastTick = Date.now();

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i, items.length);
      done++;
      if (Date.now() - lastTick > 1000) {
        lastTick = Date.now();
        process.stdout.write(`\r  Progress: ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(`\r  Progress: ${done}/${items.length}\n`);
  return results;
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  TOFF Broken Images Audit`);
  console.log(`  Store:        ${STORE_ID}`);
  console.log(`  Limit:        ${LIMIT || "all"}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log(`  Check mode:   ${CHECK_ALL ? "all images per product" : "main image only (Product.image)"}`);
  if (DUMP_PATH) console.log(`  Dump CSV to:  ${DUMP_PATH}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1] Loading products from Neo4j...`);
  const products = await fetchAllProducts();
  console.log(`    Loaded ${products.length} products\n`);

  // ── Quick stats on what's stored ───────────────────────────────────
  const noImage = products.filter(p => !p.image).length;
  const withImage = products.length - noImage;
  console.log(`[2] Storage stats:`);
  console.log(`    Has Product.image:    ${withImage}`);
  console.log(`    Missing Product.image: ${noImage}\n`);

  // ── HEAD check main image ──────────────────────────────────────────
  console.log(`[3] HEAD checking Product.image (concurrency ${CONCURRENCY})...`);
  const checked = await mapWithConcurrency(products, CONCURRENCY, async p => {
    if (!p.image) return { ...p, mainStatus: 0, mainError: "null-url" };
    const r = await headStatus(p.image);
    return { ...p, mainStatus: r.status, mainError: r.error };
  });

  // Categorize
  const ok = checked.filter(p => p.mainStatus === 200);
  const notFound = checked.filter(p => p.mainStatus === 404);
  const otherStatus = checked.filter(p => p.mainStatus !== 200 && p.mainStatus !== 404 && p.mainStatus !== 0);
  const errors = checked.filter(p => p.mainStatus === 0);

  console.log(`\n[4] Main image (Product.image) results:\n`);
  console.log(`    ✓ 200 OK:           ${ok.length}  (${pct(ok.length, products.length)})`);
  console.log(`    ✗ 404 Not Found:    ${notFound.length}  (${pct(notFound.length, products.length)})`);
  console.log(`    ✗ Other status:     ${otherStatus.length}  (${pct(otherStatus.length, products.length)})`);
  console.log(`    ✗ Network/timeout:  ${errors.length}  (${pct(errors.length, products.length)})`);
  console.log(`    ──────────────────────────────`);
  const broken = notFound.length + otherStatus.length + errors.length;
  console.log(`    TOTAL BROKEN:       ${broken}  (${pct(broken, products.length)})`);

  if (otherStatus.length > 0) {
    const breakdown = {};
    for (const p of otherStatus) breakdown[p.mainStatus] = (breakdown[p.mainStatus] || 0) + 1;
    console.log(`    Other status breakdown: ${JSON.stringify(breakdown)}`);
  }
  if (errors.length > 0) {
    const breakdown = {};
    for (const p of errors) breakdown[p.mainError] = (breakdown[p.mainError] || 0) + 1;
    console.log(`    Network error breakdown: ${JSON.stringify(breakdown)}`);
  }

  // ── Optional: full image arrays ────────────────────────────────────
  if (CHECK_ALL) {
    console.log(`\n[5] HEAD checking Product.images[] (every image per product)...`);
    let totalImages = 0;
    let brokenImages = 0;
    const productsWithSomeBroken = [];
    const productsWithAllBroken = [];

    const flat = [];
    for (const p of products) {
      for (const url of (p.images || [])) {
        flat.push({ pid: p.id, handle: p.handle, url });
      }
    }
    totalImages = flat.length;

    const flatChecked = await mapWithConcurrency(flat, CONCURRENCY, async f => {
      const r = await headStatus(f.url);
      return { ...f, status: r.status };
    });

    const byProduct = {};
    for (const f of flatChecked) {
      if (!byProduct[f.pid]) byProduct[f.pid] = { pid: f.pid, handle: f.handle, total: 0, broken: 0 };
      byProduct[f.pid].total++;
      if (f.status !== 200) {
        byProduct[f.pid].broken++;
        brokenImages++;
      }
    }
    for (const v of Object.values(byProduct)) {
      if (v.broken > 0) productsWithSomeBroken.push(v);
      if (v.broken === v.total) productsWithAllBroken.push(v);
    }

    console.log(`\n    Total image URLs checked:  ${totalImages}`);
    console.log(`    Broken image URLs:         ${brokenImages}  (${pct(brokenImages, totalImages)})`);
    console.log(`    Products with ≥1 broken:   ${productsWithSomeBroken.length}  (${pct(productsWithSomeBroken.length, products.length)})`);
    console.log(`    Products with ALL broken:  ${productsWithAllBroken.length}  (${pct(productsWithAllBroken.length, products.length)})`);
  }

  // ── Sample broken ──────────────────────────────────────────────────
  if (broken > 0) {
    console.log(`\n[6] Sample broken products (first 10):\n`);
    const sample = [...notFound, ...otherStatus, ...errors].slice(0, 10);
    for (const p of sample) {
      const reason = p.mainError ? `ERR(${p.mainError})` : `HTTP ${p.mainStatus}`;
      console.log(`    [${reason}] ${p.handle}`);
      console.log(`        ${p.image}`);
    }
  }

  // ── Optional CSV dump ─────────────────────────────────────────────
  if (DUMP_PATH && broken > 0) {
    const rows = [["productId", "handle", "title", "status", "error", "image"]];
    for (const p of [...notFound, ...otherStatus, ...errors]) {
      rows.push([p.id, p.handle, (p.title || "").replace(/"/g, '""'), p.mainStatus, p.mainError || "", p.image]);
    }
    const csv = rows.map(r => r.map(c => `"${c ?? ""}"`).join(",")).join("\n");
    fs.writeFileSync(DUMP_PATH, csv);
    console.log(`\n  Wrote ${rows.length - 1} broken rows to ${DUMP_PATH}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════\n`);
}

function pct(n, total) {
  if (!total) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
