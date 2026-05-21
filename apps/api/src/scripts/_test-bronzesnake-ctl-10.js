#!/usr/bin/env node

/**
 * Smoke test: run Complete The Look for N random Bronze Snake products and
 * inspect each cached outfit to verify whether the hero image URL is being
 * served (vs the raw images[0]).
 *
 * Read-only on Shopify. Writes nothing back to Neo4j or Shopify. The Dynamo
 * cache is touched (deleted + repopulated by the Lambda — same as production).
 *
 * Usage:
 *   node apps/api/src/scripts/_test-bronzesnake-ctl-10.js
 *   node apps/api/src/scripts/_test-bronzesnake-ctl-10.js --count 10
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import AWS from "aws-sdk";
import crypto from "crypto";
import fetch from "node-fetch";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

const STORE_ID = "bronze-snake-1.myshopify.com";
const LAMBDA_URL_BASE = "https://7gduqkaho5pvkb6rfvfcfeg6ca0ymnid.lambda-url.us-east-1.on.aws/";

const args = process.argv.slice(2);
const countIdx = args.indexOf("--count");
const COUNT = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : 10;

AWS.config.update({ region: AWS_REGION });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

async function pickRandomProducts() {
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product {storeId: $storeId})
       WHERE p.handle IS NOT NULL AND p.handle <> ''
       WITH p, rand() AS r
       ORDER BY r
       LIMIT $count
       RETURN p.id AS id, p.handle AS handle, p.title AS title,
              p.heroImage AS heroImage, p.heroImageIndex AS heroIndex,
              p.images AS images`,
      { storeId: STORE_ID, count: neo4j.int(COUNT) }
    );
    return r.records.map(rec => ({
      id: rec.get("id"),
      handle: rec.get("handle"),
      title: rec.get("title"),
      heroImage: rec.get("heroImage"),
      heroIndex: rec.get("heroIndex"),
      images: rec.get("images") || []
    }));
  } finally {
    await session.close();
  }
}

async function lookupHeroForHandles(handles) {
  if (!handles.length) return new Map();
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product {storeId: $storeId})
       WHERE p.handle IN $handles
       RETURN p.handle AS handle, p.heroImage AS heroImage,
              p.images AS images, p.heroImageIndex AS heroIndex`,
      { storeId: STORE_ID, handles }
    );
    const m = new Map();
    for (const rec of r.records) {
      m.set(rec.get("handle"), {
        heroImage: rec.get("heroImage"),
        heroIndex: rec.get("heroIndex"),
        images: rec.get("images") || []
      });
    }
    return m;
  } finally {
    await session.close();
  }
}

async function deleteCacheItem(handle) {
  const cacheId = `${STORE_ID}_${handle}_en`;
  try {
    await docClient.delete({ TableName: CACHE_TABLE, Key: { id: cacheId } }).promise();
  } catch (e) {
    console.error(`   cache delete failed: ${e.message}`);
  }
}

async function readCacheForProduct(handle) {
  const cacheId = `${STORE_ID}_${handle}_en`;
  const res = await docClient.get({ TableName: CACHE_TABLE, Key: { id: cacheId } }).promise();
  return res.Item || null;
}

function buildLambdaUrl(product) {
  const channelId = `runa_${STORE_ID}_${crypto.randomUUID()}-outfit`;
  const params = new URLSearchParams({
    userId: "default-2",
    domain: STORE_ID,
    productId: product.id,
    personality: "classic, romantic",
    chromatic: "autumn",
    isNeutral: 0,
    channelId,
    action: "gpt-4",
    actionId: crypto.randomUUID(),
    tokens: 1024,
    temperature: 1,
    model1: "",
    model2: "",
    skipCaching: false,
    productHandle: product.handle,
    profileId: "",
    language: "en"
  });
  return `${LAMBDA_URL_BASE}?${params.toString()}`;
}

async function callLambda(product) {
  const url = buildLambdaUrl(product);
  await deleteCacheItem(product.handle);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`, ms };
    }
    const data = await res.json();
    return { ok: true, data, ms };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

function extractProductsFromCtl(item) {
  const out = [];
  const outfits = item?.data?.outfits || [];
  for (const outfit of outfits) {
    const ps = outfit?.products_for_outfit || [];
    for (const p of ps) out.push(p);
  }
  return out;
}

function pickImageUrl(p) {
  return (
    p?.image ||
    p?.imageUrl ||
    p?.image_url ||
    p?.heroImage ||
    p?.thumbnail ||
    (Array.isArray(p?.images) ? p.images[0] : null) ||
    null
  );
}

(async () => {
  try {
    console.log(`\nPicking ${COUNT} random Bronze Snake products...`);
    const sources = await pickRandomProducts();
    console.log(`Picked ${sources.length} products:\n`);
    sources.forEach((p, i) => {
      const heroNote = p.heroImage ? `hero set (idx ${p.heroIndex ?? "?"})` : `NO hero`;
      console.log(`  ${i + 1}. ${p.title}`);
      console.log(`     handle: ${p.handle}   id: ${p.id}   ${heroNote}`);
    });

    console.log(`\n──── Calling CTL Lambda for each ────────────────────────────`);
    const results = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const product = { id: s.id, handle: s.handle, title: s.title, storeId: STORE_ID };
      process.stdout.write(`[${i + 1}/${sources.length}] ${product.handle}... `);
      const r = await callLambda(product);
      console.log(r.ok ? `ok (${r.ms}ms)` : `FAIL: ${r.error}`);
      results.push({ source: s, lambda: r });
    }

    console.log(`\n──── Inspecting cache results ───────────────────────────────`);
    const allHandles = new Set();
    const cached = [];
    for (const { source } of results) {
      const item = await readCacheForProduct(source.handle);
      if (!item) {
        cached.push({ source, item: null, products: [] });
        continue;
      }
      const products = extractProductsFromCtl(item);
      cached.push({ source, item, products });
      for (const p of products) {
        if (p?.handle) allHandles.add(p.handle);
      }
    }

    const heroLookup = await lookupHeroForHandles([...allHandles]);

    let totalReferenced = 0;
    let withHeroInNeo4j = 0;
    let cachedUrlMatchesHero = 0;
    let cachedUrlMatchesImages0 = 0;
    let cachedUrlOther = 0;
    let firstProductFieldDump = null;

    for (const { source, item, products } of cached) {
      console.log(`\n── ${source.title}`);
      console.log(`   handle: ${source.handle}`);
      if (!item) {
        console.log(`   (no cache item — Lambda may have failed)`);
        continue;
      }
      const outfits = item.data?.outfits || [];
      console.log(`   outfits: ${outfits.length}, products in outfits: ${products.length}`);
      products.forEach((p, idx) => {
        if (!firstProductFieldDump && p) {
          firstProductFieldDump = { keys: Object.keys(p), example: p };
        }
        totalReferenced++;
        const url = pickImageUrl(p);
        const lookup = p.handle ? heroLookup.get(p.handle) : null;
        let tag;
        if (!lookup) {
          tag = "neo4j: NOT FOUND";
        } else if (lookup.heroImage) {
          withHeroInNeo4j++;
          if (url === lookup.heroImage) {
            cachedUrlMatchesHero++;
            tag = `MATCHES hero (idx ${lookup.heroIndex ?? "?"})`;
          } else if (lookup.images?.[0] && url === lookup.images[0]) {
            cachedUrlMatchesImages0++;
            tag = `uses images[0] (hero exists at idx ${lookup.heroIndex ?? "?"} — ignored)`;
          } else {
            cachedUrlOther++;
            tag = `OTHER url (hero idx ${lookup.heroIndex ?? "?"})`;
          }
        } else {
          tag = "no hero in Neo4j";
        }
        console.log(`     ${idx + 1}. ${p.handle || "?"}: ${tag}`);
        if (url) console.log(`        cached: ${url}`);
        if (lookup?.heroImage && url !== lookup.heroImage) {
          console.log(`        hero:   ${lookup.heroImage}`);
        }
      });
    }

    if (firstProductFieldDump) {
      console.log(`\n──── First outfit-product fields (for shape reference) ──────`);
      console.log(`Keys: ${firstProductFieldDump.keys.join(", ")}`);
      const ex = firstProductFieldDump.example;
      const slim = {};
      for (const k of firstProductFieldDump.keys) {
        const v = ex[k];
        if (typeof v === "string" && v.length > 200) slim[k] = v.slice(0, 200) + "…";
        else if (Array.isArray(v) && v.length > 3) slim[k] = [...v.slice(0, 3), `…(${v.length} total)`];
        else slim[k] = v;
      }
      console.log(JSON.stringify(slim, null, 2));
    }

    console.log(`\n══════════ SUMMARY ══════════════════════════════════════════`);
    console.log(`Source products tested:                  ${sources.length}`);
    console.log(`Products referenced in CTL outfits:      ${totalReferenced}`);
    console.log(`  with heroImage in Neo4j:               ${withHeroInNeo4j}`);
    console.log(`    cached url MATCHES hero:             ${cachedUrlMatchesHero}`);
    console.log(`    cached url uses images[0] instead:   ${cachedUrlMatchesImages0}`);
    console.log(`    cached url is something else:        ${cachedUrlOther}`);
    console.log(`═════════════════════════════════════════════════════════════\n`);
  } catch (err) {
    console.error("Fatal:", err);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
})();
