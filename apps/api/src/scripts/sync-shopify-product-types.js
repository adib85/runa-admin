#!/usr/bin/env node

/**
 * Sync Product Types via Gemini Classification
 *
 * Fetches products from Neo4j, sends titles to Gemini to classify into
 * predefined subcategories, then saves the product type back to both
 * Neo4j and Shopify.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-shopify-product-types.js <shop-domain> [access-token] [options]
 *
 * Options:
 *   --preset <her|him>      Category preset to use (default: her)
 *   --dry-run               Classify products without writing anything
 *   --missing               Only process products without a product_type set
 *   --force                 Re-classify ALL products (even those with existing product_type)
 *   --handle <handle>       Process a single product by handle
 *   --batch-size <n>        Number of titles per Gemini request (default: 25)
 *   --gemini-model <model>  Override Gemini model
 *
 * Examples:
 *   node apps/api/src/scripts/sync-shopify-product-types.js k8xbf0-5t.myshopify.com --preset her
 *   node apps/api/src/scripts/sync-shopify-product-types.js wp557k-d1.myshopify.com --preset him --missing
 *   node apps/api/src/scripts/sync-shopify-product-types.js k8xbf0-5t.myshopify.com --dry-run
 *   node apps/api/src/scripts/sync-shopify-product-types.js k8xbf0-5t.myshopify.com --handle petar-petrov-bicolor-cashmere-sweater
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

// ─── Category taxonomy (presets) ─────────────────────────────────────

const PRESETS = {
  her: [
    {
      category: "Clothing",
      subcategories: [
        "Coats & Jackets", "Dresses", "Tops & Blouses", "T-Shirts & Vests",
        "Knitwear", "Suits & Blazers", "Trousers", "Jeans", "Skirts",
        "Shorts", "Activewear", "Lingerie & Nightwear", "Swimwear",
        "Jumpsuits & Playsuits"
      ]
    },
    {
      category: "Shoes",
      subcategories: [
        "Sneakers", "Heels & Pumps", "Boots & Ankle Boots", "Sandals",
        "Flats & Ballerinas", "Mules & Slides", "Espadrilles & Wedges"
      ]
    },
    {
      category: "Bags",
      subcategories: [
        "Shoulder Bags", "Crossbody Bags", "Tote Bags",
        "Clutches & Evening Bags", "Backpacks", "Wallets & Purses"
      ]
    },
    {
      category: "Accessories",
      subcategories: [
        "Sunglasses", "Belts", "Scarves & Wraps",
        "Hats & Hair Accessories", "Tech Accessories"
      ]
    },
    {
      category: "Jewellery",
      subcategories: [
        "Rings", "Earrings", "Necklaces & Pendants",
        "Bracelets & Bangles", "Watches", "Brooches"
      ]
    }
  ],
  him: [
    {
      category: "Clothing",
      subcategories: [
        "T-Shirts & Polos", "Shirts", "Knitwear", "Coats & Jackets",
        "Suits & Blazers", "Trousers & Chinos", "Jeans", "Shorts",
        "Activewear", "Swimwear", "Underwear & Loungewear"
      ]
    },
    {
      category: "Shoes",
      subcategories: [
        "Sneakers", "Boots", "Loafers & Slip-Ons",
        "Sandals & Slides", "Formal Shoes"
      ]
    },
    {
      category: "Bags",
      subcategories: [
        "Backpacks", "Briefcases & Work Bags", "Tote Bags"
      ]
    },
    {
      category: "Accessories",
      subcategories: [
        "Sunglasses", "Watches", "Hats & Caps", "Belts",
        "Scarves & Gloves", "Wallets & Cardholders",
        "Tech Accessories", "Ties and Formal Accessories"
      ]
    },
    {
      category: "Jewellery",
      subcategories: [
        "Necklaces & Chains", "Bracelets & Cuffs", "Rings",
        "Cufflinks & Tie Bars", "Brooches"
      ]
    }
  ]
};

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  const prev = args[i - 1];
  return !["--handle", "--batch-size", "--gemini-model", "--preset"].includes(prev);
});

const SHOP_DOMAIN = positional[0] || process.env.SHOP_DOMAIN || "k8xbf0-5t.myshopify.com";
let ACCESS_TOKEN = positional[1] || process.env.ACCESS_TOKEN;

const dryRun = args.includes("--dry-run");
const forceAll = args.includes("--force");
const missingOnly = args.includes("--missing");

const presetIdx = args.indexOf("--preset");
const PRESET_NAME = presetIdx !== -1 ? args[presetIdx + 1] : "her";
const CATEGORY_MENU = PRESETS[PRESET_NAME];
if (!CATEGORY_MENU) {
  console.error(`Unknown preset "${PRESET_NAME}". Available: ${Object.keys(PRESETS).join(", ")}`);
  process.exit(1);
}
const ALL_SUBCATEGORIES = CATEGORY_MENU.flatMap(c => c.subcategories);
const CATEGORY_LIST_TEXT = CATEGORY_MENU
  .map(c => `${c.category}: ${c.subcategories.join(", ")}`)
  .join("\n");

const handleIdx = args.indexOf("--handle");
const singleHandle = handleIdx !== -1 ? args[handleIdx + 1] : null;

const batchSizeIdx = args.indexOf("--batch-size");
const BATCH_SIZE = batchSizeIdx !== -1 ? parseInt(args[batchSizeIdx + 1], 10) : 25;

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
        subcategory: {
          type: SchemaType.STRING,
          format: "enum",
          enum: ALL_SUBCATEGORIES,
          description: "The subcategory that best matches the product title",
        },
      },
      required: ["index", "subcategory"],
    },
  };
}

async function classifyBatch(products) {
  const numbered = products
    .map((p, i) => `${i + 1}. "${p.title}"`)
    .join("\n");

  const prompt = `You are a fashion product classifier. Given the product titles below, assign each one to the MOST appropriate subcategory.

Products to classify:
${numbered}

RULES:
- You MUST classify every product (return one entry per product).
- If uncertain, pick the closest match.`;

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
        classifications[products[idx].id] = item.subcategory;
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

const UPDATE_PRODUCT_TYPE_MUTATION = gql`
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id productType }
      userErrors { field message }
    }
  }
`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateShopifyProductType(productId, productType, maxRetries = 3) {
  const gid = `gid://shopify/Product/${productId}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { productUpdate } = await shopifyClient.request(UPDATE_PRODUCT_TYPE_MUTATION, {
        input: { id: gid, productType }
      });

      if (productUpdate.userErrors.length > 0) {
        throw new Error(productUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join(", "));
      }

      return productUpdate.product;
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
      ? "AND (p.product_type IS NULL OR trim(p.product_type) = '')"
      : "";
    const forceFilter = forceAll
      ? ""
      : "AND (p.product_type_classified_at IS NULL)";

    const query = `
      MATCH (p:Product)
      WHERE p.storeId = $storeId
        ${missingFilter}
        ${forceFilter}
      RETURN p.id AS id, p.title AS title, p.handle AS handle,
             p.product_type AS currentType
      ORDER BY p.updated_at DESC`;

    const result = await session.run(query, { storeId: SHOP_DOMAIN });
    return result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      currentType: r.get("currentType"),
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
              p.product_type AS currentType`,
      { storeId: SHOP_DOMAIN, handle }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      id: r.get("id"),
      title: r.get("title"),
      handle: r.get("handle"),
      currentType: r.get("currentType"),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

async function updateNeo4jProductType(productId, productType) {
  const driver = getDriver();
  const session = driver.session();
  try {
    await session.run(
      `MATCH (p:Product {id: $productId, storeId: $storeId})
       SET p.product_type = $productType,
           p.product_type_classified_at = $classifiedAt
       RETURN p.id AS id`,
      {
        productId,
        storeId: SHOP_DOMAIN,
        productType,
        classifiedAt: new Date().toISOString(),
      }
    );
  } finally {
    await session.close();
    await driver.close();
  }
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
  console.log(`  Sync Product Types (Gemini Classification)`);
  console.log(`  Store:  ${SHOP_DOMAIN}`);
  console.log(`  Preset: ${PRESET_NAME} (${ALL_SUBCATEGORIES.length} subcategories)`);
  console.log(`  Model:  ${GEMINI_MODEL}`);
  console.log(`  Batch:  ${BATCH_SIZE} titles per Gemini request`);
  console.log(`  Mode:   ${dryRun ? "DRY RUN (no updates)" : "LIVE (will update Neo4j + Shopify)"}`);
  console.log(`  Filter: ${missingOnly ? "MISSING ONLY" : forceAll ? "ALL (force re-classify)" : "Not yet classified"}`);
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
    console.log(`    Found: "${product.title}" (id: ${product.id})`);
    console.log(`    Current type: ${product.currentType || "(none)"}`);
    products = [product];
  } else {
    console.log(`[1] Fetching products from Neo4j...`);
    products = await getProducts();
    console.log(`    Found ${products.length} products to classify\n`);
  }

  if (products.length === 0) {
    console.log("Nothing to do — all products already classified.");
    return;
  }

  const stats = { classified: 0, updated: 0, skipped: 0, errors: 0 };
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
      console.log(`${batchTag} Sending ${batch.length} titles to Gemini...`);
      const { classifications, usage } = await classifyBatch(batch);
      const count = Object.keys(classifications).length;
      const costStr = usage ? ` | ${usage.input}+${usage.output} tokens, $${usage.costUSD.toFixed(6)}` : "";
      console.log(`${batchTag} Got ${count}/${batch.length} classifications${costStr}`);

      Object.assign(allClassifications, classifications);
      stats.classified += count;
      stats.skipped += batch.length - count;
    } catch (error) {
      console.error(`${batchTag} ERROR: ${error.message}`);
      stats.errors += batch.length;
    }

    if (b < batches.length - 1) await delay(1000);
  }

  console.log(`\n[3] Saving product types to Neo4j + Shopify...\n`);

  let saveCount = 0;
  const total = Object.keys(allClassifications).length;

  for (const [productId, productType] of Object.entries(allClassifications)) {
    saveCount++;
    const product = products.find(p => p.id === productId);
    const tag = `[${saveCount}/${total}]`;

    try {
      if (dryRun) {
        console.log(`${tag} "${product?.title}" → ${productType} (DRY RUN)`);
      } else {
        await updateNeo4jProductType(productId, productType);
        await updateShopifyProductType(productId, productType);
        console.log(`${tag} "${product?.title}" → ${productType}`);
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
  console.log(`    Products:   ${products.length}`);
  console.log(`    Classified: ${stats.classified}`);
  console.log(`    Updated:    ${stats.updated}`);
  console.log(`    Skipped:    ${stats.skipped}`);
  console.log(`    Errors:     ${stats.errors}`);
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
