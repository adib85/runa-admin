#!/usr/bin/env node
// Standalone manual demo curation tool.
//
// Completely independent of the apps/api runtime demo pipeline. Its only
// shared surface with the main project is the DynamoDB cache key it writes
// (`demo_<domain>` in CacheTable) — that's the contract that makes the
// curated outfit show up in /demo?website=<domain>.
//
// Usage:
//   node tools/manual-curate.mjs <input-file>            # dry run, no write
//   node tools/manual-curate.mjs <input-file> --write    # write to DynamoDB
//   node tools/manual-curate.mjs <input-file> --min 7    # custom score floor (default 8)
//   node tools/manual-curate.mjs <input-file> --no-critic  # skip scoring entirely
//
// Input file format (matches the original playbook):
//
//   Outfit 1:
//   (HERO) https://store.com/products/anchor-handle
//   https://store.com/products/item-1-handle
//   https://store.com/products/item-2-handle
//
//   Outfit 2:
//   (HERO) https://store.com/products/another-anchor
//   ...
//
// Exit codes: 0 = ok, 1 = parse/fetch error, 2 = critic rejected (any
// outfit < min score), 3 = missing input.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) die("GEMINI_API_KEY missing in env (.env at repo root)");

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const DEMO_STORE_ID = "demo_searches";

const PARSE_MODEL = "gemini-2.5-flash-lite";
const CRITIC_MODEL = "gemini-2.5-flash";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Critic prompt ──────────────────────────────────────────────────
// Self-contained, apparel-aware. Designed for stores whose catalog
// doesn't include shoes/bags/jewelry (e.g. Indian ethnic apparel,
// boutique cut-and-sew brands). The runtime critic in apps/api assumes
// every store has accessories — that's wrong for ~60% of fashion stores.
// This script makes ZERO assumptions about catalog breadth and judges the
// outfit purely on what's actually there.

const CRITIC_PROMPT = `You are a senior fashion stylist auditing a hand-curated outfit for {{storeName}}.

Anchor: {{anchor}}
Items:
{{items}}

You have the product images attached. Judge the outfit visually — colors,
materials, embellishments, formality, and styling concept — using ONLY what
the items actually show. Do not penalize the outfit for missing categories
(shoes, bags, jewelry, etc.) that the store may not carry.

Scoring rubric (1-10):

10  Editorial-grade. Cohesive concept, every piece earns its place,
    photographable as a single look.
8-9 Strong outfit a stylist would publish. Minor improvement possible.
6-7 Workable but generic, or one weak item. Acceptable for a baseline demo.
4-5 Visual flaws: color clash, formality mismatch, or one piece that
    doesn't belong.
1-3 Broken: actively bad combination, or pieces that fight each other.

Hard rules (any single occurrence drops to <= 4):
1. Metal-tone clash on embellishments (gold zardozi paired with silver
   mirror work, etc.).
2. Cool + warm color clash on the same intensity tier (deep forest green
   with warm orange-red, both saturated).
3. Formality mismatch (bridal couture paired with casual loungewear).
4. Implicit duplicates (jewelry "set with earrings" + separately added
   earrings = two pairs of earrings).

Compositions that are EXPLICITLY ALLOWED and should NOT auto-fail:
- Bridesmaids / coordinated set: 3-4 of the same garment type in a tonal
  color story (e.g. four lehengas in sky blue / pista / pink / purple).
- Family or couple wedding: women's anchor + men's matching kurta + kids
  matching outfit. Cross-gender in this composition is intentional.
- Saree + standalone blouse + standalone dupatta: complete look with
  alternative styling pieces is the whole point — not a "duplicate".
- Print + print is fine when the prints share a palette and intensity tier
  (most Indian ethnic styling is print-on-print by tradition).

Return ONLY this JSON, no markdown:

{
  "score": 8,
  "approved": true,
  "concept": "one-sentence description of the outfit's styling story",
  "issues": ["short string", ...]
}

approved must be true if score >= 7, false otherwise.`;

const PARSE_PROMPT = `Extract outfits from the text below into structured JSON.

Each outfit has exactly one HERO (anchor) and one or more complementary URLs.
Preserve the order from the input. Strip whitespace. Skip duplicate URLs
within an outfit.

Return ONLY JSON:

{
  "domain": "example.com",
  "outfits": [
    { "hero": "https://...", "items": ["https://...", "..."] }
  ]
}

domain = bare hostname shared by all URLs (no scheme, no www., no slash).

INPUT:
"""
{{input}}
"""`;

// ─── CLI parse ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { write: false, critic: true, minScore: 8, inputFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--no-critic") args.critic = false;
    else if (a === "--min" || a === "--min-score") {
      args.minScore = Number(argv[++i]);
      if (!Number.isFinite(args.minScore)) die(`bad --min value: ${argv[i]}`);
    } else if (a === "--help" || a === "-h") {
      console.log(usageText());
      process.exit(0);
    } else if (!args.inputFile) args.inputFile = a;
    else die(`unexpected arg: ${a}`);
  }
  if (!args.inputFile) {
    console.error(usageText());
    process.exit(3);
  }
  return args;
}

function usageText() {
  return `Usage: node tools/manual-curate.mjs <input-file> [options]

Options:
  --write           Write to DynamoDB if all outfits >= min score (default: dry run)
  --no-critic       Skip critic scoring entirely (use when iterating fast)
  --min N           Score floor required to write (default: 8)
  -h, --help        Show this help

Independent of apps/api. Only shared surface with main project is the
DynamoDB cache key 'demo_<domain>' which the runtime /demo?website= reads.`;
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ─── HTTP helpers ───────────────────────────────────────────────────

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json,text/html,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchImageAsBase64(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA, Accept: "image/*" },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      contentType: r.headers.get("content-type") || "image/jpeg",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── Gemini wrappers ────────────────────────────────────────────────

function gemini(modelName, json = false) {
  const ai = new GoogleGenerativeAI(GEMINI_KEY);
  const opts = { model: modelName };
  if (json) opts.generationConfig = { responseMimeType: "application/json" };
  return ai.getGenerativeModel(opts);
}

async function parseInput(rawText) {
  const m = gemini(PARSE_MODEL, true);
  const prompt = PARSE_PROMPT.replace("{{input}}", rawText);
  const r = await m.generateContent(prompt);
  const txt = r.response.text().trim();
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`Gemini parse returned non-JSON: ${txt.slice(0, 200)}`);
  }
}

async function scoreOutfit(outfit, storeName) {
  const anchorDesc = `"${outfit.anchor.title}"`;
  const itemDescs = outfit.items
    .map((it, i) => `${i}: "${it.title}"`)
    .join("\n");
  const text = CRITIC_PROMPT.replace("{{storeName}}", storeName)
    .replace("{{anchor}}", anchorDesc)
    .replace("{{items}}", itemDescs);

  const all = [
    { ...outfit.anchor, label: "ANCHOR" },
    ...outfit.items.map((it, i) => ({ ...it, label: `ITEM ${i}` })),
  ];
  const images = (
    await Promise.all(
      all
        .filter((p) => p.image)
        .map(async (p) => {
          const img = await fetchImageAsBase64(p.image);
          return img ? { ...img, label: p.label, title: p.title } : null;
        })
    )
  ).filter(Boolean);

  const parts = [];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
    parts.push(`(${img.label}: "${img.title}")`);
  }
  parts.push(text);

  const m = gemini(CRITIC_MODEL);
  const r = await m.generateContent(parts);
  const raw = r.response.text().replace(/```json\n?|\n?```/g, "").trim();
  try {
    const j = JSON.parse(raw);
    return {
      score: Number(j.score) || 0,
      approved: !!j.approved,
      concept: j.concept || "",
      issues: Array.isArray(j.issues) ? j.issues : [],
    };
  } catch {
    throw new Error(`Critic returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// ─── Shopify helpers ────────────────────────────────────────────────

function urlToHandle(productUrl) {
  const m = productUrl.match(/\/products\/([^/?#]+)/i);
  if (!m) throw new Error(`Cannot extract product handle from: ${productUrl}`);
  return m[1];
}

async function fetchStoreMeta(domain) {
  const data = await fetchJson(`https://${domain}/meta.json`);
  if (!data?.name) throw new Error(`/meta.json has no name for ${domain}`);
  return { name: data.name, currency: data.currency || "USD" };
}

async function fetchProduct(domain, handle) {
  const data = await fetchJson(`https://${domain}/products/${handle}.json`);
  if (!data?.product) throw new Error(`Empty product response for ${handle}`);
  return data.product;
}

async function fetchCounts(domain) {
  let collections = 0;
  for (let page = 1; page <= 5; page++) {
    try {
      const d = await fetchJson(
        `https://${domain}/collections.json?limit=250&page=${page}`
      );
      const cols = d.collections || [];
      if (!cols.length) break;
      collections += cols.filter((c) => (c.products_count || 0) > 0).length;
    } catch {
      break;
    }
  }
  let products = 0;
  try {
    const d = await fetchJson(`https://${domain}/products.json?limit=250`);
    products = (d.products || []).length;
  } catch {}
  return { collections, products };
}

function shapeAnchor(p) {
  const tags = Array.isArray(p.tags)
    ? p.tags
    : (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    type: p.product_type || "",
    vendor: p.vendor || "",
    tags,
    price: p.variants?.[0]?.price || "0.00",
    image: p.images?.[0]?.src || p.image?.src || null,
    collection: (p.product_type || "all").toLowerCase().replace(/\s+/g, "-"),
  };
}

function shapeItem(p) {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    price: p.variants?.[0]?.price || "0.00",
    image: p.images?.[0]?.src || p.image?.src || null,
    vendor: p.vendor || "",
    collection: (p.product_type || "all").toLowerCase().replace(/\s+/g, "-"),
  };
}

function buildOutfit(anchor, items, name) {
  const total = [anchor, ...items].reduce(
    (s, p) => s + parseFloat(p.price || 0),
    0
  );
  return {
    anchor,
    items,
    outfit_name: name,
    total_price: total.toFixed(2),
  };
}

// ─── DynamoDB write ─────────────────────────────────────────────────

async function writeCache(domain, storeName, payload) {
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AWS_REGION })
  );
  await ddb.send(
    new PutCommand({
      TableName: CACHE_TABLE,
      Item: {
        id: `demo_${domain}`,
        storeId: DEMO_STORE_ID,
        domain,
        storeName,
        result: payload,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
  );
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  console.log(`▶ Reading ${args.inputFile}`);
  const inputPath = path.isAbsolute(args.inputFile)
    ? args.inputFile
    : path.resolve(process.cwd(), args.inputFile);
  const rawText = await fs.readFile(inputPath, "utf8");

  console.log("▶ Parsing outfits via Gemini...");
  const parsed = await parseInput(rawText);
  if (!parsed.domain || !parsed.outfits?.length) {
    die("Gemini returned no domain or no outfits");
  }
  const domain = parsed.domain.toLowerCase();
  console.log(`  domain=${domain}, outfits=${parsed.outfits.length}`);

  console.log(`▶ Fetching store meta for ${domain}...`);
  const meta = await fetchStoreMeta(domain);
  console.log(`  name=${meta.name}, currency=${meta.currency}`);

  console.log("▶ Fetching catalog counts...");
  const counts = await fetchCounts(domain);
  console.log(`  ${counts.products} sample products, ${counts.collections} collections`);

  console.log("▶ Fetching products + building outfits...");
  const outfits = [];
  for (const [i, o] of parsed.outfits.entries()) {
    const heroP = await fetchProduct(domain, urlToHandle(o.hero));
    const itemPs = [];
    for (const u of o.items) itemPs.push(await fetchProduct(domain, urlToHandle(u)));
    const built = buildOutfit(
      shapeAnchor(heroP),
      itemPs.map(shapeItem),
      `Outfit ${i + 1}`
    );
    outfits.push(built);
    console.log(
      `  Outfit ${i + 1}: ${built.anchor.title} + ${built.items.length} items, total ${built.total_price} ${meta.currency}`
    );
  }

  let scores = [];
  let rejected = false;
  if (args.critic) {
    console.log(`▶ Scoring outfits (floor: ${args.minScore})...`);
    for (const [i, o] of outfits.entries()) {
      process.stdout.write(`  [${i + 1}/${outfits.length}] ${o.anchor.title.slice(0, 60)}... `);
      const review = await scoreOutfit(o, meta.name);
      o.criticScore = review.score;
      o.criticIssues = review.issues;
      o.criticConcept = review.concept;
      scores.push(review.score);
      const verdict = review.score >= args.minScore ? "PASS" : "FAIL";
      console.log(`${review.score}/10 ${verdict}`);
      if (review.concept) console.log(`      concept: ${review.concept}`);
      if (review.issues?.length) {
        console.log(`      issues:`);
        for (const iss of review.issues)
          console.log(
            `        - ${typeof iss === "string" ? iss : JSON.stringify(iss)}`
          );
      }
    }
    rejected = scores.some((s) => s < args.minScore);
    console.log(`  scores: [${scores.join(", ")}], rejected=${rejected}`);
  } else {
    console.log("▶ Critic skipped (--no-critic).");
  }

  const payload = {
    store: { name: meta.name, domain, currency: meta.currency },
    outfit: outfits[0],
    alternativeOutfits: outfits.slice(1),
    productCount: counts.products,
    collectionCount: counts.collections,
  };

  if (args.write && !rejected) {
    console.log(`▶ Writing demo_${domain} to ${CACHE_TABLE}...`);
    await writeCache(domain, meta.name, payload);
    console.log("✓ Saved.");
    return 0;
  }

  if (args.write && rejected) {
    console.error(
      `✗ Rejected: at least one outfit < ${args.minScore}. Cache NOT updated.`
    );
    return 2;
  }

  console.log("(dry run — pass --write to persist)");
  return 0;
}

main().then((c) => process.exit(c || 0)).catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
