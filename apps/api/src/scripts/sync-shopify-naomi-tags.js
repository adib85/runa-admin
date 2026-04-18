#!/usr/bin/env node

/**
 * Sync Naomi Tags — Occasion, Style Lane & Naomi's Picks
 *
 * Classifies products using Gemini into occasions (Date Night, Office, etc.),
 * style lanes (Classic Tailoring, Minimalist Modern, etc.), and flags standout
 * "Naomi's Picks". Saves as Shopify tags + Neo4j properties.
 *
 * Tags added to Shopify (additive — won't remove existing tags):
 *   naomi:date-night, naomi:office-ready, naomi:vacation, naomi:casual,
 *   naomi:evening, naomi:weekend, naomi:pick,
 *   style:classic-tailoring, style:evening, style:minimalist, etc.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-shopify-naomi-tags.js <shop-domain> [access-token] [options]
 *
 * Options:
 *   --dry-run               Classify without writing anything
 *   --missing               Only process products not yet tagged
 *   --force                 Re-classify ALL products
 *   --handle <handle>       Process a single product by handle
 *   --batch-size <n>        Titles per Gemini request (default: 20)
 *   --gemini-model <model>  Override Gemini model
 *
 * Examples:
 *   node apps/api/src/scripts/sync-shopify-naomi-tags.js k8xbf0-5t.myshopify.com --dry-run
 *   node apps/api/src/scripts/sync-shopify-naomi-tags.js k8xbf0-5t.myshopify.com --missing
 *   node apps/api/src/scripts/sync-shopify-naomi-tags.js k8xbf0-5t.myshopify.com --handle alexander-mcqueen-blue-cotton-casual-dress
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
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";
import { geminiWithRetry } from "../sync/utils/index.js";

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

// ─── Taxonomy ────────────────────────────────────────────────────────

const OCCASIONS = [
  "Date Night",
  "Office Ready",
  "Vacation & Resort",
  "Casual Everyday",
  "Evening & Events",
  "Weekend",
];

const STYLE_LANES = [
  "Classic Tailoring",
  "Evening / Going Out",
  "Minimalist Modern",
  "Athleisure / Sporty",
  "Bohemian / Romantic",
  "Streetwear / Urban",
  "Resort / Vacation",
  "Rock / Edgy",
  "Preppy / Smart Casual",
];

const OCCASION_TO_TAG = {
  "Date Night":        "naomi:date-night",
  "Office Ready":      "naomi:office-ready",
  "Vacation & Resort": "naomi:vacation",
  "Casual Everyday":   "naomi:casual",
  "Evening & Events":  "naomi:evening",
  "Weekend":           "naomi:weekend",
};

const STYLE_TO_TAG = {
  "Classic Tailoring":   "style:classic-tailoring",
  "Evening / Going Out": "style:evening",
  "Minimalist Modern":   "style:minimalist",
  "Athleisure / Sporty": "style:athleisure",
  "Bohemian / Romantic": "style:bohemian",
  "Streetwear / Urban":  "style:streetwear",
  "Resort / Vacation":   "style:resort",
  "Rock / Edgy":         "style:rock-edgy",
  "Preppy / Smart Casual": "style:preppy",
};

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  const prev = args[i - 1];
  return !["--handle", "--batch-size", "--gemini-model"].includes(prev);
});

const SHOP_DOMAIN = positional[0] || process.env.SHOP_DOMAIN || "k8xbf0-5t.myshopify.com";
let ACCESS_TOKEN = positional[1] || process.env.ACCESS_TOKEN;

const dryRun = args.includes("--dry-run");
const forceAll = args.includes("--force");
const missingOnly = args.includes("--missing");

const handleIdx = args.indexOf("--handle");
const singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;

const batchSizeIdx = args.indexOf("--batch-size");
const BATCH_SIZE = batchSizeIdx !== -1 ? parseInt(args[batchSizeIdx + 1], 10) : 20;

const geminiModelIdx = args.indexOf("--gemini-model");
const GEMINI_MODEL = geminiModelIdx !== -1
  ? args[geminiModelIdx + 1]
  : "gemini-3.1-flash-lite-preview";

const RATE_LIMIT_DELAY_MS = 500;

// ─── Gemini AI client + cost tracking ────────────────────────────────

const GEMINI_PRICING = {
  "gemini-3.1-flash-lite-preview": { inputPer1M: 0.25, outputPer1M: 1.50 },
  "gemini-3-flash-preview":        { inputPer1M: 0.10, outputPer1M: 0.40 },
};

const tokenTotals = { input: 0, output: 0, totalCostUSD: 0 };

function trackUsage(usageMetadata) {
  if (!usageMetadata) return;
  const input = usageMetadata.promptTokenCount || 0;
  const output = usageMetadata.candidatesTokenCount || 0;
  tokenTotals.input += input;
  tokenTotals.output += output;

  const pricing = GEMINI_PRICING[GEMINI_MODEL] || { inputPer1M: 0.25, outputPer1M: 1.50 };
  const costUSD = (input / 1e6) * pricing.inputPer1M + (output / 1e6) * pricing.outputPer1M;
  tokenTotals.totalCostUSD += costUSD;
  return { input, output, costUSD };
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function buildResponseSchema() {
  return {
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.OBJECT,
      properties: {
        index: {
          type: SchemaType.INTEGER,
          description: "1-based index of the product in the input list",
        },
        occasions: {
          type: SchemaType.ARRAY,
          description: "1 to 3 occasions this product is best suited for",
          items: {
            type: SchemaType.STRING,
            format: "enum",
            enum: OCCASIONS,
          },
        },
        style_lane: {
          type: SchemaType.STRING,
          format: "enum",
          enum: STYLE_LANES,
          description: "The primary style lane this product belongs to",
        },
        naomi_pick: {
          type: SchemaType.BOOLEAN,
          description: "True if this is a standout editorial piece worthy of a curated selection",
        },
      },
      required: ["index", "occasions", "style_lane", "naomi_pick"],
    },
  };
}

async function classifyBatch(products) {
  const numbered = products
    .map((p, i) => {
      let line = `${i + 1}. "${p.title}"`;
      if (p.vendor) line += ` [${p.vendor}]`;
      if (p.productType) line += ` (${p.productType})`;
      return line;
    })
    .join("\n");

  const prompt = `You are Naomi, a luxury fashion AI stylist for RUNWAYHER / RUNWAYHIM. Classify each product below.

For each product, determine:

1. **Occasions** (1–3): When would someone wear/use this piece?
   - "Date Night" — romantic dinner, cocktails, intimate evening
   - "Office Ready" — professional, business meetings, workwear
   - "Vacation & Resort" — beach, poolside, tropical getaway, travel
   - "Casual Everyday" — weekend brunch, errands, relaxed daily wear
   - "Evening & Events" — gala, party, red carpet, formal events
   - "Weekend" — leisure, park, friends gathering, laid-back outings

2. **Style Lane** (exactly 1): The product's aesthetic world.
   Use brand identity as the strongest signal:
   - Max Mara, The Row, Brunello Cucinelli → "Classic Tailoring"
   - Saint Laurent evening, Tom Ford gowns → "Evening / Going Out"
   - Jil Sander, Lemaire, Totême → "Minimalist Modern"
   - Marine Serre, Palm Angels, Moncler sport → "Athleisure / Sporty"
   - Zimmermann, Etro, Chloé → "Bohemian / Romantic"
   - Off-White, Balenciaga casual, Vetements → "Streetwear / Urban"
   - Cult Gaia, Johanna Ortiz, resort lines → "Resort / Vacation"
   - Saint Laurent rock, Alexander McQueen, Balmain → "Rock / Edgy"
   - Ralph Lauren, Thom Browne, Gant → "Preppy / Smart Casual"

3. **Naomi's Pick** (true/false): Is this a standout editorial piece?
   True = strong styling potential, hero piece from a prestigious brand, statement item.
   Be selective — only ~15-20% of products should be picks.

Products:
${numbered}`;

  const result = await geminiWithRetry(async () => {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: buildResponseSchema(),
      },
    });
    const response = await model.generateContent(prompt);
    return response;
  });

  const text = result.response.text().trim();
  const usage = trackUsage(result.response.usageMetadata);

  try {
    const parsed = JSON.parse(text);
    const classifications = {};

    for (const item of parsed) {
      const idx = item.index - 1;
      if (idx >= 0 && idx < products.length) {
        classifications[products[idx].id] = {
          occasions: item.occasions || [],
          style_lane: item.style_lane,
          naomi_pick: item.naomi_pick || false,
        };
      }
    }
    return { classifications, usage };
  } catch (e) {
    console.error(`    ✗ Failed to parse Gemini response: ${e.message}`);
    console.error(`    Raw response: ${text.substring(0, 200)}...`);
    return { classifications: {}, usage };
  }
}

// ─── Access token ────────────────────────────────────────────────────

async function fetchAccessTokenFromDB(shopDomain) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shopDomain}`;
  const response = await fetch(url);
  const data = await response.json();
  const token = data?.data?.accessToken;
  if (!token) {
    throw new Error(`No accessToken found in database for shop "${shopDomain}"`);
  }
  console.log(`  Access token fetched from database for ${shopDomain}`);
  return token;
}

// ─── Shopify GraphQL ─────────────────────────────────────────────────

let shopifyClient;

const TAGS_ADD_MUTATION = gql`
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = gql`
  mutation tagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ALL_NAOMI_TAGS = [
  ...Object.values(OCCASION_TO_TAG),
  ...Object.values(STYLE_TO_TAG),
  "naomi:pick",
];

async function updateShopifyTags(productId, tags, maxRetries = 3) {
  const gid = `gid://shopify/Product/${productId}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (forceAll) {
        await shopifyClient.request(TAGS_REMOVE_MUTATION, { id: gid, tags: ALL_NAOMI_TAGS });
      }

      const { tagsAdd } = await shopifyClient.request(TAGS_ADD_MUTATION, { id: gid, tags });

      if (tagsAdd.userErrors.length > 0) {
        throw new Error(tagsAdd.userErrors.map(e => `${e.field}: ${e.message}`).join(", "));
      }

      return tagsAdd.node;
    } catch (error) {
      const is5xx = error.message?.includes("503") || error.message?.includes("500") || error.message?.includes("502");
      if (is5xx && attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
        console.log(`    [Retry] 5xx error, waiting ${(backoff / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})...`);
        await delay(backoff);
        continue;
      }
      throw error;
    }
  }
}

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getProducts() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const missingFilter = missingOnly
      ? "AND (p.naomi_occasions IS NULL)"
      : "";
    const forceFilter = forceAll
      ? ""
      : "AND (p.naomi_tagged_at IS NULL)";

    const query = `
      MATCH (p:Product)
      WHERE p.storeId = $storeId
        ${missingFilter}
        ${forceFilter}
      RETURN p.id AS id, p.title AS title, p.handle AS handle,
             p.vendor AS vendor, p.product_type AS productType
      ORDER BY p.updated_at DESC`;

    const result = await session.run(query, { storeId: SHOP_DOMAIN });
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      vendor: r.get("vendor"),
      productType: r.get("productType"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function getProductByHandle(handle) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId AND p.handle = $handle
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.vendor AS vendor, p.product_type AS productType`,
      { storeId: SHOP_DOMAIN, handle }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      vendor: r.get("vendor"),
      productType: r.get("productType"),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

async function updateNeo4jNaomiTags(productId, data) {
  const driver = getDriver();
  const session = driver.session();
  try {
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.naomi_occasions = $occasions,
           p.naomi_style_lane = $styleLane,
           p.naomi_pick = $naomiPick,
           p.naomi_tagged_at = $taggedAt
       RETURN p.id AS id`,
      {
        productId,
        storeId: SHOP_DOMAIN,
        occasions: data.occasions,
        styleLane: data.style_lane,
        naomiPick: data.naomi_pick,
        taggedAt: new Date().toISOString(),
      }
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Build Shopify tags from classification ──────────────────────────

function buildTags(data) {
  const tags = [];
  for (const occ of data.occasions) {
    if (OCCASION_TO_TAG[occ]) tags.push(OCCASION_TO_TAG[occ]);
  }
  if (STYLE_TO_TAG[data.style_lane]) tags.push(STYLE_TO_TAG[data.style_lane]);
  if (data.naomi_pick) tags.push("naomi:pick");
  return tags;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  if (!ACCESS_TOKEN) {
    ACCESS_TOKEN = await fetchAccessTokenFromDB(SHOP_DOMAIN);
  }

  shopifyClient = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
    headers: {
      "X-Shopify-Access-Token": ACCESS_TOKEN,
      "Content-Type": "application/json"
    }
  });

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Naomi Tags — Occasion + Style Lane + Picks`);
  console.log(`  Store:  ${SHOP_DOMAIN}`);
  console.log(`  Model:  ${GEMINI_MODEL}`);
  console.log(`  Batch:  ${BATCH_SIZE} titles per Gemini request`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN (no updates)" : "LIVE (will update Neo4j + Shopify)"}`);
  console.log(`  Filter: ${missingOnly ? "MISSING ONLY" : forceAll ? "ALL (force re-tag)" : "Not yet tagged"}`);
  if (singleHandle) console.log(`  Handle: ${singleHandle}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  let products;

  if (singleHandle) {
    console.log(`[1] Looking up handle "${singleHandle}" in Neo4j...`);
    const product = await getProductByHandle(singleHandle);
    if (!product) {
      console.log(`    Product not found in Neo4j for handle "${singleHandle}"`);
      return;
    }
    console.log(`    Found: "${product.title}" [${product.vendor}] (${product.productType || "no type"})`);
    products = [product];
  } else {
    console.log(`[1] Fetching products from Neo4j...`);
    products = await getProducts();
    console.log(`    Found ${products.length} products to classify\n`);
  }

  if (products.length === 0) {
    console.log("Nothing to do — all products already tagged.");
    return;
  }

  const stats = { classified: 0, updated: 0, skipped: 0, errors: 0, picks: 0 };
  const occasionCounts = {};
  OCCASIONS.forEach(o => occasionCounts[o] = 0);
  const laneCounts = {};
  STYLE_LANES.forEach(l => laneCounts[l] = 0);

  const batches = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    batches.push(products.slice(i, i + BATCH_SIZE));
  }

  console.log(`[2] Classifying ${products.length} products in ${batches.length} batch(es)...\n`);

  const allClassifications = {};

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchTag = `[Batch ${b + 1}/${batches.length}]`;

    try {
      console.log(`${batchTag} Sending ${batch.length} products to Gemini...`);
      const { classifications, usage } = await classifyBatch(batch);
      const count = Object.keys(classifications).length;
      const picks = Object.values(classifications).filter(c => c.naomi_pick).length;
      const costStr = usage ? ` | ${usage.input}+${usage.output} tokens, $${usage.costUSD.toFixed(6)}` : "";
      console.log(`${batchTag} Got ${count}/${batch.length} (${picks} picks)${costStr}`);

      Object.assign(allClassifications, classifications);
      stats.classified += count;
      stats.skipped += batch.length - count;
    } catch (error) {
      console.error(`${batchTag} ERROR: ${error.message}`);
      stats.errors += batch.length;
    }

    if (b < batches.length - 1) await delay(1000);
  }

  console.log(`\n[3] Saving tags to Neo4j + Shopify...\n`);

  let saveCount = 0;
  const total = Object.keys(allClassifications).length;

  for (const [productId, data] of Object.entries(allClassifications)) {
    saveCount++;
    const product = products.find(p => p.id === productId);
    const tag = `[${saveCount}/${total}]`;
    const tags = buildTags(data);
    const pickFlag = data.naomi_pick ? " ★" : "";

    for (const occ of data.occasions) occasionCounts[occ]++;
    laneCounts[data.style_lane]++;
    if (data.naomi_pick) stats.picks++;

    try {
      if (dryRun) {
        console.log(`${tag} "${product?.title}"${pickFlag}`);
        console.log(`      Occasions: ${data.occasions.join(", ")} | Lane: ${data.style_lane}`);
        console.log(`      Tags: ${tags.join(", ")}`);
      } else {
        await updateNeo4jNaomiTags(productId, data);
        await updateShopifyTags(productId, tags);
        console.log(`${tag} "${product?.title}"${pickFlag} → ${tags.join(", ")}`);
      }
      stats.updated++;
    } catch (error) {
      console.error(`${tag} "${product?.title}" — ERROR: ${error.message}`);
      stats.errors++;
    }

    await delay(RATE_LIMIT_DELAY_MS);
  }

  const costPerProduct = products.length > 0 ? tokenTotals.totalCostUSD / products.length : 0;
  const est1k = costPerProduct * 1000;

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Products:     ${products.length}`);
  console.log(`    Classified:   ${stats.classified}`);
  console.log(`    Updated:      ${stats.updated}`);
  console.log(`    Naomi Picks:  ${stats.picks}`);
  console.log(`    Errors:       ${stats.errors}`);
  console.log(`  ─────────────────────────────────────────────────────────`);
  console.log(`  OCCASIONS`);
  for (const [occ, count] of Object.entries(occasionCounts)) {
    if (count > 0) console.log(`    ${occ.padEnd(20)} ${count}`);
  }
  console.log(`  ─────────────────────────────────────────────────────────`);
  console.log(`  STYLE LANES`);
  for (const [lane, count] of Object.entries(laneCounts)) {
    if (count > 0) console.log(`    ${lane.padEnd(24)} ${count}`);
  }
  console.log(`  ─────────────────────────────────────────────────────────`);
  console.log(`  COST (${GEMINI_MODEL})`);
  console.log(`    Input tokens:    ${tokenTotals.input.toLocaleString()}`);
  console.log(`    Output tokens:   ${tokenTotals.output.toLocaleString()}`);
  console.log(`    Total cost:      $${tokenTotals.totalCostUSD.toFixed(6)}`);
  console.log(`    Per product:     $${costPerProduct.toFixed(6)}`);
  console.log(`    Est. 1,000 products: $${est1k.toFixed(4)}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
