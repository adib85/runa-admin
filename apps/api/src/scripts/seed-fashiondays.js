#!/usr/bin/env node

/**
 * Seed the Fashion Days demo cache directly into DynamoDB.
 *
 * Fully self-contained — does NOT import the new bypass code in
 * `demoSeed.js`, so it runs cleanly even if your production API hasn't
 * been redeployed yet. Visits each Fashion Days product page, extracts
 * the main product image (og:image) + title/brand/price from the embedded
 * gtmProductData JSON, then writes the curated payload to DynamoDB under
 * `demo_fashiondays.ro`.
 *
 * Usage:
 *   node apps/api/src/scripts/seed-fashiondays.js
 *   node apps/api/src/scripts/seed-fashiondays.js --dry-run
 *   node apps/api/src/scripts/seed-fashiondays.js --file path/to/outfits.txt
 *   node apps/api/src/scripts/seed-fashiondays.js --concurrency 8
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "@runa/config";
import { dynamoClient } from "@runa/core/database/dynamodb";

const FASHION_DAYS_DOMAIN = "fashiondays.ro";
const DEMO_STORE_ID = "demo_searches";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── CLI args ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    dryRun: false,
    file: path.resolve(__dirname, "FashionDays"),
    concurrency: 5,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--file") args.file = path.resolve(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 5);
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node seed-fashiondays.js [--dry-run] [--file <path>] [--concurrency <n>]"
      );
      process.exit(0);
    }
  }
  return args;
}

// ─── Input parser ─────────────────────────────────────────────────────

function parseOutfits(rawText) {
  const lines = rawText.split(/\r?\n/);
  const outfits = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Outfit\s+\d+/i.test(line)) {
      if (current) outfits.push(current);
      current = { hero: null, items: [] };
      continue;
    }
    if (!current) current = { hero: null, items: [] };
    const isHero = /^\(HERO\)/i.test(line);
    const url = line.replace(/^\(HERO\)\s*/i, "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (isHero) current.hero = url;
    else current.items.push(url);
  }
  if (current) outfits.push(current);
  return outfits
    .map((o) => {
      if (!o.hero && o.items.length) return { hero: o.items[0], items: o.items.slice(1) };
      return o;
    })
    .filter((o) => o.hero);
}

// ─── HTTP fetch ───────────────────────────────────────────────────────
// Tencent EdgeOne (Fashion Days' WAF) blocks node-fetch's TLS fingerprint
// with a captcha challenge page. Node's native fetch (undici) gets through.

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── HTML extractors ──────────────────────────────────────────────────

function extractMeta(html, prop) {
  const re1 = new RegExp(
    `<meta[^>]*(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m = html.match(re1) || html.match(re2);
  return m ? m[1] : null;
}

function extractAllOgImages(html) {
  const re = /<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/gi;
  const re2 = /<meta[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/gi;
  const all = new Set();
  let m;
  while ((m = re.exec(html)) !== null) all.add(m[1]);
  while ((m = re2.exec(html)) !== null) all.add(m[1]);
  return [...all];
}

function extractGtmProduct(html) {
  const m = html.match(/var\s+gtmProductData\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1])?.product || null;
  } catch {
    return null;
  }
}

function extractJsonLdPrice(html) {
  const m = html.match(/"price"\s*:\s*"([\d.]+)"/);
  return m ? m[1] : null;
}

function slugFromUrl(url) {
  const m = url.match(/\/p\/([^/?#]+)/i);
  return m ? m[1] : url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/.*$/, "");
}

function productIdFromUrl(url) {
  const m = url.match(/-p(\d+)-/i);
  return m ? Number(m[1]) : null;
}

// ─── Per-product scraper ──────────────────────────────────────────────

async function scrapeProduct(url) {
  const html = await fetchPage(url);

  const ogTitle = extractMeta(html, "og:title");
  const allImages = extractAllOgImages(html);
  // First og:image is always the main product shot on Fashion Days.
  const image = allImages[0] || null;
  const gtm = extractGtmProduct(html);
  const jsonLdPrice = extractJsonLdPrice(html);

  const slug = slugFromUrl(url);
  const productId = gtm?.productId || productIdFromUrl(url) || slug;
  const title = (gtm?.name || ogTitle || slug.replace(/-/g, " ")).trim();
  const vendor = gtm?.brandName || "";
  const price = (gtm?.price ?? jsonLdPrice ?? 0).toString();
  const collection = (gtm?.subClassification || gtm?.classification || "category")
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "-");

  if (!image) {
    throw new Error(`No image extracted for ${url}`);
  }

  return {
    id: productId,
    title,
    handle: slug,
    type: gtm?.subClassification || "",
    vendor,
    tags: [],
    price,
    image,
    collection,
    sourceUrl: url,
  };
}

// ─── Concurrency-limited map ──────────────────────────────────────────

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Outfit assembly ──────────────────────────────────────────────────

function buildOutfitObj(anchor, items, name) {
  const total = [anchor, ...items].reduce((s, p) => s + parseFloat(p.price || 0), 0);
  return { anchor, items, outfit_name: name, total_price: total.toFixed(2) };
}

async function buildOutfit({ hero, items }, index, concurrency) {
  const allUrls = [hero, ...items];
  const products = await mapWithLimit(allUrls, concurrency, scrapeProduct);
  const anchor = products[0];
  const itemObjs = products.slice(1).map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    price: p.price,
    image: p.image,
    vendor: p.vendor,
    collection: p.collection,
  }));
  return buildOutfitObj(anchor, itemObjs, `Outfit ${index + 1}`);
}

// ─── DynamoDB write ───────────────────────────────────────────────────

async function saveCache(payload) {
  const docClient = dynamoClient.getDocClient();
  await docClient.send(
    new PutCommand({
      TableName: config.dynamodb.tables.cache,
      Item: {
        id: `demo_${FASHION_DAYS_DOMAIN}`,
        storeId: DEMO_STORE_ID,
        domain: FASHION_DAYS_DOMAIN,
        storeName: "Fashion Days",
        result: payload,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
  );
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, file, concurrency } = parseArgs(process.argv);

  console.log(`Reading outfit URLs from: ${file}`);
  const raw = readFileSync(file, "utf8");
  const parsed = parseOutfits(raw);
  if (!parsed.length) throw new Error("No outfits parsed from input");

  const totalProducts = parsed.reduce((n, o) => n + 1 + o.items.length, 0);
  console.log(
    `Found ${parsed.length} outfits, ${totalProducts} products total. Scraping with concurrency=${concurrency}...\n`
  );

  const t0 = Date.now();
  const outfits = [];
  for (let i = 0; i < parsed.length; i++) {
    process.stdout.write(`  Outfit ${i + 1}/${parsed.length}... `);
    const t = Date.now();
    const outfit = await buildOutfit(parsed[i], i, concurrency);
    console.log(`${Date.now() - t}ms (${1 + outfit.items.length} products)`);
    outfits.push(outfit);
  }

  const payload = {
    store: {
      name: "Fashion Days",
      domain: FASHION_DAYS_DOMAIN,
      currency: "RON",
      productPathPrefix: "/p",
    },
    outfit: outfits[0],
    alternativeOutfits: outfits.slice(1),
    productCount: totalProducts,
    collectionCount: parsed.length,
    isFashionDays: true,
  };

  console.log(`\nScraping done in ${Date.now() - t0}ms.\n`);
  console.log("─── Outfits ──────────────────────────────────────────────────────");
  for (const o of outfits) {
    console.log(`\n${o.outfit_name} — total ${o.total_price} RON`);
    console.log(`  ANCHOR  ${o.anchor.title}`);
    console.log(`          ${o.anchor.vendor || "(no brand)"} · ${o.anchor.price} RON`);
    console.log(`          ${o.anchor.image}`);
    for (const it of o.items) {
      console.log(`  · ${it.title}`);
      console.log(`      ${it.vendor || "(no brand)"} · ${it.price} RON`);
      console.log(`      ${it.image}`);
    }
  }

  if (dryRun) {
    console.log("\nDRY RUN — nothing written to DynamoDB.");
  } else {
    console.log("\nWriting to DynamoDB...");
    await saveCache(payload);
    console.log(`✓ Saved cache key: demo_${FASHION_DAYS_DOMAIN}`);
  }

  console.log(`\nVisit: https://demo.askruna.ai/?url=https://www.${FASHION_DAYS_DOMAIN}/`);
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
