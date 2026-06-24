#!/usr/bin/env node

/**
 * Bronze Snake — backfill p.styleFilters (from the custom.style_filters_new
 * Shopify metafield, normalized), p.sizeChartJson (from the custom.size_*
 * measurement metafields) and p.sizeTokens (parsed from the already-synced
 * p.sizes variant titles) onto existing Product nodes.
 *
 * The nightly sync maintains both fields for new/updated products
 * (shopify.js / base.js / neo4j.js); this fills in everything already indexed.
 *
 * Shopify access is READ-ONLY (GraphQL product reads).
 * Default is dry-run. Use --apply to write.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-bronzesnake-style-filters.js
 *   node apps/api/src/scripts/backfill-bronzesnake-style-filters.js --apply
 *   node apps/api/src/scripts/backfill-bronzesnake-style-filters.js --apply --gemini   # + AI pass for products the regex can't parse
 *   node apps/api/src/scripts/backfill-bronzesnake-style-filters.js --apply --token shpat_xxx
 *
 * Material: extractMaterials() (regex) covers the ~58% with structured
 * "Material:" lines for free. --gemini batch-classifies the remainder from
 * title+description (40 products/call, "unknown" allowed, ~$1 one-off).
 *
 * Revert: MATCH (p:Product {storeId:'bronze-snake-1.myshopify.com'})
 *         REMOVE p.styleFilters, p.sizeTokens, p.sizeChartJson, p.published_date,
 *                p.price_old, p.onSale, p.materialDominant, p.materials, p.materialComposition
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import { normalizeStyleFilters, parseSizeTokens, buildSizeChartJson, SIZE_CHART_METAFIELDS, extractMaterials } from "../sync/utils/style-filters.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const API_VERSION = "2024-10";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const GEMINI = args.includes("--gemini");
const tokenIdx = args.indexOf("--token");
// Reuse whatever Gemini key the sync's AI services use (see services/ config / .env).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function fetchAccessToken() {
  if (tokenIdx !== -1 && args[tokenIdx + 1]) return args[tokenIdx + 1];
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const j = await r.json();
  const t = j?.data?.accessToken;
  if (!t) throw new Error(`No accessToken for ${SHOP} (pass --token shpat_...)`);
  return t;
}

async function fetchShopifyMetafields(token) {
  const byId = new Map(); // bare product id -> { styles: [], sizeChartJson: string|null }
  // alias per size-chart key: m_size_bust: metafield(...){ value } ...
  const sizeAliases = Object.keys(SIZE_CHART_METAFIELDS)
    .map(k => `m_${k}: metafield(namespace:"custom", key:"${k}"){ value }`)
    .join(" ");
  let cursor = null;
  // 75/page: 12 metafields per product keeps the GraphQL query cost under the 1000 cap.
  for (let page = 0; page < 200; page++) {
    const q = `query($c: String){ products(first: 75, after: $c){
      pageInfo{hasNextPage endCursor}
      nodes{ id publishedAt styleMeta: metafield(namespace:"custom", key:"style_filters_new"){ value } ${sizeAliases} } } }`;
    const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: q, variables: { c: cursor } })
    });
    const j = await r.json();
    if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 300));
    const pr = j.data.products;
    for (const n of pr.nodes) {
      const id = n.id.replace("gid://shopify/Product/", "");
      const chartInput = {};
      for (const [key, dim] of Object.entries(SIZE_CHART_METAFIELDS)) {
        chartInput[dim] = n[`m_${key}`]?.value;
      }
      byId.set(id, {
        styles: normalizeStyleFilters(n.styleMeta?.value),
        sizeChartJson: buildSizeChartJson(chartInput),
        publishedAt: n.publishedAt || null
      });
    }
    if (!pr.pageInfo.hasNextPage) break;
    cursor = pr.pageInfo.endCursor;
    await new Promise(res => setTimeout(res, 300));
  }
  return byId;
}

// Batched Gemini classification for products extractMaterials() returned null on.
// Strict instruction: assign ONLY materials stated in the text, else "unknown" —
// no guessing from product type. All-string schema (avoids the Gemini 3.x
// numeric-field stall). REST endpoint = no SDK dependency.
async function geminiClassifyMaterials(candidates) {
  const ALLOWED = "cotton, linen, polyester, viscose, rayon, wool, silk, leather, suede, vegan-leather, denim, nylon, elastane, acrylic, cashmere, jersey, satin, mesh, knit, fleece, canvas, straw, felt, stainless-steel, sterling-silver, gold-plated, resin, acetate";
  const strip = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const out = [];
  for (let i = 0; i < candidates.length; i += 40) {
    const batch = candidates.slice(i, i + 40);
    const items = batch.map(r => ({ id: r.id, category: r.cat, title: r.title, text: strip(r.description).slice(0, 500) }));
    const body = {
      contents: [{ role: "user", parts: [{ text:
        `For each fashion product below, identify its material ONLY if the text explicitly states it. ` +
        `dominant = the main material (one of: ${ALLOWED}) or "unknown" if the text doesn't say. ` +
        `materials = all stated materials from that list (empty if unknown). Never infer from the product type alone.\n\n` +
        JSON.stringify(items) }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: { classifications: { type: "array", items: { type: "object",
            properties: {
              id: { type: "string" },
              dominant: { type: "string" },
              materials: { type: "array", items: { type: "string" } }
            }, required: ["id", "dominant", "materials"] } } },
          required: ["classifications"]
        }
      }
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "{}";
    try {
      for (const c of (JSON.parse(text).classifications || [])) {
        if (c.dominant && c.dominant !== "unknown") {
          out.push({ id: String(c.id), dominant: c.dominant, materials: c.materials?.length ? c.materials : [c.dominant] });
        }
      }
    } catch (e) { console.log(`  gemini batch ${i / 40} parse error: ${e.message}`); }
    console.log(`  gemini ${Math.min(i + 40, candidates.length)}/${candidates.length}`);
    await new Promise(res => setTimeout(res, 400));
  }
  return out;
}

async function main() {
  const token = await fetchAccessToken();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN (use --apply to write)"}`);

  const metaById = await fetchShopifyMetafields(token);
  console.log(`Shopify: ${metaById.size} products read, ` +
    `${[...metaById.values()].filter(v => v.styles.length).length} with style values, ` +
    `${[...metaById.values()].filter(v => v.sizeChartJson).length} with size charts`);

  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
  );
  const session = driver.session();
  try {
    // All indexed products + sizes/description (sizeTokens + materials derive from Neo4j data).
    const res = await session.run(
      `MATCH (p:Product {storeId: $sid})
       RETURN toString(p.id) AS id, p.sizes AS sizes, p.title AS title, p.category AS cat, p.description AS description`,
      { sid: SHOP }
    );
    const rows = res.records.map(r => {
      const id = r.get("id");
      const meta = metaById.get(id) || { styles: [], sizeChartJson: null, publishedAt: null };
      const mat = extractMaterials(r.get("description"));
      return {
        id,
        title: r.get("title"),
        cat: r.get("cat"),
        description: r.get("description"),
        styles: meta.styles,
        sizeChartJson: meta.sizeChartJson,
        publishedAt: meta.publishedAt,
        sizeTokens: parseSizeTokens(r.get("sizes") || []),
        materialDominant: mat?.dominant || null,
        materials: mat?.materials || null,
        materialComposition: mat?.composition || null
      };
    });

    const withStyles = rows.filter(r => r.styles.length).length;
    const withSizes = rows.filter(r => r.sizeTokens.length).length;
    const withCharts = rows.filter(r => r.sizeChartJson).length;
    const withDates = rows.filter(r => r.publishedAt).length;
    const withMaterial = rows.filter(r => r.materialDominant).length;
    const materialCandidates = rows.filter(r => !r.materialDominant && (r.description || "").length > 50);
    console.log(`Neo4j: ${rows.length} products | styleFilters: ${withStyles} | sizeTokens: ${withSizes} | sizeChartJson: ${withCharts} | published_date: ${withDates}`);
    console.log(`Material: ${withMaterial} via regex | ${materialCandidates.length} candidates for --gemini pass${GEMINI ? "" : " (flag not set — they stay null)"}`);

    // style slug distribution (for the chat prompt's allowed-style list)
    const dist = {};
    rows.forEach(r => r.styles.forEach(s => dist[s] = (dist[s] || 0) + 1));
    console.log("\nTop style slugs on indexed products:");
    Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 40)
      .forEach(([s, n]) => console.log(`  ${s}: ${n}`));

    if (!APPLY) { console.log("\n(dry run — nothing written)"); return; }

    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await session.run(
        `UNWIND $batch AS row
         MATCH (p:Product {storeId: $sid}) WHERE toString(p.id) = row.id
         SET p.styleFilters = row.styles, p.sizeTokens = row.sizeTokens, p.sizeChartJson = row.sizeChartJson,
             p.published_date = row.publishedAt,
             p.materialDominant = row.materialDominant, p.materials = row.materials,
             p.materialComposition = row.materialComposition`,
        { batch, sid: SHOP }
      );
      console.log(`  wrote ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }

    // Optional Gemini pass for products the regex couldn't parse.
    if (GEMINI) {
      if (!GEMINI_API_KEY) throw new Error("--gemini needs GEMINI_API_KEY in the environment");
      const classified = await geminiClassifyMaterials(materialCandidates);
      console.log(`Gemini classified ${classified.length} of ${materialCandidates.length} candidates`);
      for (let i = 0; i < classified.length; i += 500) {
        await session.run(
          `UNWIND $batch AS row
           MATCH (p:Product {storeId: $sid}) WHERE toString(p.id) = row.id
           SET p.materialDominant = row.dominant, p.materials = row.materials,
               p.materialComposition = coalesce(p.materialComposition, row.dominant)`,
          { batch: classified.slice(i, i + 500), sid: SHOP }
        );
      }
    }

    // Sale state — derived purely from the Variant nodes already in Neo4j.
    const saleRes = await session.run(
      `MATCH (p:Product {storeId: $sid})-[:HAS_VARIANT]->(v:Variant)
       WITH p,
            max(CASE WHEN v.price_old IS NOT NULL AND toFloat(v.price_old) > toFloat(v.price) THEN 1 ELSE 0 END) AS sale,
            min(CASE WHEN v.price_old IS NOT NULL AND toFloat(v.price_old) > toFloat(v.price) THEN toFloat(v.price_old) ELSE null END) AS priceOld
       SET p.onSale = (sale = 1), p.price_old = priceOld
       RETURN sum(sale) AS onSaleProducts`,
      { sid: SHOP }
    );
    console.log(`Sale state: ${saleRes.records[0].get("onSaleProducts")} products marked onSale`);
    console.log("\n✅ Backfill complete.");
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(e => { console.error("Backfill failed:", e); process.exit(1); });
