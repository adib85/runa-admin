#!/usr/bin/env node

/**
 * Naomi Curated Outfits
 *
 * Picks hero products per occasion from Naomi-tagged products, generates
 * complete outfits via the Complete The Look lambda, and saves the curated
 * collection to DynamoDB for frontend display.
 *
 * Flow:
 *   1. Query Neo4j for naomi:pick products grouped by occasion
 *   2. Select 1 hero per occasion from the best category
 *   3. Call Complete The Look lambda for each hero → full 4-piece outfit
 *   4. Save curated outfits JSON to DynamoDB (CacheTable)
 *
 * Usage:
 *   node apps/api/src/scripts/sync-naomi-curated-outfits.js <shop-domain> [options]
 *
 * Options:
 *   --dry-run               Generate outfits without saving
 *   --gemini-model <model>  Override Gemini model for CTL lambda
 *   --language <lang>       Language code (default: en)
 *
 * Examples:
 *   node apps/api/src/scripts/sync-naomi-curated-outfits.js k8xbf0-5t.myshopify.com --dry-run
 *   node apps/api/src/scripts/sync-naomi-curated-outfits.js k8xbf0-5t.myshopify.com
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import crypto from "crypto";
import AWS from "aws-sdk";
import { GraphQLClient, gql } from "graphql-request";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { config as runaConfig } from "@runa/config";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const LAMBDA_URL_BASE = "https://7gduqkaho5pvkb6rfvfcfeg6ca0ymnid.lambda-url.us-east-1.on.aws/";

AWS.config.update({ region: AWS_REGION });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── Occasion config ─────────────────────────────────────────────────

const OCCASIONS = [
  {
    id: "date-night",
    label: "Date Night Look",
    tag: "naomi:date-night",
    preferredCategories: ["dresses", "tops & blouses", "skirts", "jumpsuits & playsuits"],
    description: "Romantic dinner, cocktails, an intimate evening out",
  },
  {
    id: "office-ready",
    label: "Office Ready Look",
    tag: "naomi:office-ready",
    preferredCategories: ["suits & blazers", "trousers", "coats & jackets", "tops & blouses", "shirts"],
    description: "Professional, polished, boardroom to after-work drinks",
  },
  {
    id: "vacation",
    label: "Vacation Edit — styled by Naomi",
    tag: "naomi:vacation",
    preferredCategories: ["dresses", "swimwear", "shorts", "sandals", "tops & blouses"],
    description: "Beach, poolside, resort escape",
  },
  {
    id: "casual",
    label: "Casual Everyday Look",
    tag: "naomi:casual",
    preferredCategories: ["knitwear", "jeans", "t-shirts & vests", "sneakers", "t-shirts & polos"],
    description: "Weekend brunch, errands, relaxed daily wear",
  },
  {
    id: "evening",
    label: "Evening & Events Look",
    tag: "naomi:evening",
    preferredCategories: ["dresses", "suits & blazers", "heels & pumps", "clutches & evening bags"],
    description: "Gala, party, special occasion",
  },
];

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  const prev = args[i - 1];
  return !["--gemini-model", "--language"].includes(prev);
});

const SHOP_DOMAIN = positional[0] || process.env.SHOP_DOMAIN || "k8xbf0-5t.myshopify.com";
const dryRun = args.includes("--dry-run");

const geminiModelIdx = args.indexOf("--gemini-model");
const GEMINI_MODEL = geminiModelIdx !== -1 ? args[geminiModelIdx + 1] : null;

const langIdx = args.indexOf("--language");
const LANGUAGE = langIdx !== -1 ? args[langIdx + 1] : "en";

// ─── Neo4j ───────────────────────────────────────────────────────────

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function getHeroCandidates(occasion) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.naomi_pick = true
         AND $tag IN p.naomi_occasions
         AND p.handle IS NOT NULL AND p.handle <> ''
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.vendor AS vendor, p.product_type AS productType,
              p.naomi_style_lane AS styleLane,
              p.image AS image, p.price AS price
       ORDER BY p.updated_at DESC
       LIMIT 50`,
      { storeId: SHOP_DOMAIN, tag: occasion.id.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase()).replace("Naomi:", "") }
    );

    if (result.records.length === 0) {
      const fallback = await session.run(
        `MATCH (p:Product)
         WHERE p.storeId = $storeId
           AND $occasionId IN p.naomi_occasions
           AND p.handle IS NOT NULL AND p.handle <> ''
         RETURN p.id AS id, p.title AS title, p.handle AS handle,
                p.vendor AS vendor, p.product_type AS productType,
                p.naomi_style_lane AS styleLane,
                p.image AS image, p.price AS price
         ORDER BY p.updated_at DESC
         LIMIT 50`,
        { storeId: SHOP_DOMAIN, occasionId: occasion.label.split(" —")[0] }
      );
      return fallback.records.map(mapRecord);
    }

    return result.records.map(mapRecord);
  } finally {
    await session.close();
    await driver.close();
  }
}

function mapRecord(r) {
  return {
    id: r.get("id"),
    title: r.get("title"),
    handle: r.get("handle"),
    vendor: r.get("vendor"),
    productType: r.get("productType"),
    styleLane: r.get("styleLane"),
    image: r.get("image"),
    price: r.get("price"),
  };
}

async function getNaomiPickCandidates(occasionTag) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.naomi_pick = true
         AND ANY(occ IN p.naomi_occasions WHERE occ = $occasionTag)
         AND p.handle IS NOT NULL AND p.handle <> ''
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.vendor AS vendor, p.product_type AS productType,
              p.naomi_style_lane AS styleLane,
              p.image AS image, p.price AS price
       ORDER BY rand()
       LIMIT 30`,
      { storeId: SHOP_DOMAIN, occasionTag }
    );

    if (result.records.length > 0) return result.records.map(mapRecord);

    const fallback = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND ANY(occ IN p.naomi_occasions WHERE occ = $occasionTag)
         AND p.handle IS NOT NULL AND p.handle <> ''
       RETURN p.id AS id, p.title AS title, p.handle AS handle,
              p.vendor AS vendor, p.product_type AS productType,
              p.naomi_style_lane AS styleLane,
              p.image AS image, p.price AS price
       ORDER BY rand()
       LIMIT 30`,
      { storeId: SHOP_DOMAIN, occasionTag }
    );
    return fallback.records.map(mapRecord);
  } finally {
    await session.close();
    await driver.close();
  }
}

function selectHero(candidates, preferredCategories) {
  const typeLower = (p) => (p.productType || "").toLowerCase();
  for (const pref of preferredCategories) {
    const match = candidates.find(c => typeLower(c) === pref.toLowerCase());
    if (match) return match;
  }
  return candidates[0] || null;
}

// ─── Complete The Look Lambda ────────────────────────────────────────

function buildLambdaUrl(product) {
  const channelId = `runa_${SHOP_DOMAIN}_${crypto.randomUUID()}-outfit`;
  const actionId = crypto.randomUUID();

  const params = new URLSearchParams({
    userId: "naomi-curated",
    domain: SHOP_DOMAIN,
    productId: product.id,
    personality: "classic, romantic",
    chromatic: "autumn",
    isNeutral: 0,
    channelId,
    action: "gpt-4",
    actionId,
    tokens: 1024,
    temperature: 1,
    model1: "",
    model2: "",
    skipCaching: true,
    productHandle: product.handle,
    profileId: "",
    language: LANGUAGE,
    skipImages: "true",
  });

  if (GEMINI_MODEL) params.set("geminiModel", GEMINI_MODEL);

  return `${LAMBDA_URL_BASE}?${params.toString()}`;
}

async function callLambdaOnce(product) {
  const url = buildLambdaUrl(product);
  const startTime = Date.now();
  const response = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const duration = Date.now() - startTime;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const data = await response.json();
  return { data, duration };
}

/**
 * Inspect a Lambda response and return:
 *   - finalProducts: array of {id, title} that the Lambda put in the final outfit
 *   - requestedCategories: array of {category, query, candidates: [{id, title}]} from debug
 *   - missingCategories: array of category names that were requested but missing from the final
 */
function inspectOutfitCompleteness(data) {
  const finalProducts = data?.data?.outfits?.[0]?.products_for_outfit || [];
  const debugCategories = data?.data?.debug?.outfitsResult?.outfits?.[0]?.products_by_category || [];

  const finalIds = new Set(finalProducts.map(p => String(p.id)));
  const requestedCategories = debugCategories.map(c => ({
    category: c.category,
    query: c.query,
    candidates: (c.products || []).map(p => ({ id: String(p.id), title: p.title, image: p.image })),
  }));

  const missingCategories = requestedCategories.filter(rc => {
    const candidateIds = new Set(rc.candidates.map(c => c.id));
    return ![...candidateIds].some(id => finalIds.has(id));
  });

  return { finalProducts, requestedCategories, missingCategories };
}

// ─── Stylist Critic (AI quality gate) ────────────────────────────────

const genAI = runaConfig?.gemini?.apiKey ? new GoogleGenerativeAI(runaConfig.gemini.apiKey) : null;
const CRITIC_MODEL = runaConfig?.gemini?.model || "gemini-2.5-flash";

async function fetchImageAsBase64(url, timeoutMs = 5000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return { base64: buf.toString("base64"), contentType };
  } catch {
    return null;
  }
}

/**
 * Stylist critic: looks at the hero + outfit products WITH IMAGES and judges
 * whether the outfit is complete and stylistically coherent for the occasion.
 * Returns a structured verdict with concrete next-step guidance.
 */
async function criticOutfit(hero, finalProducts, occasion) {
  if (!genAI) {
    console.log(`  [Critic] ⚠ No Gemini key — skipping critic`);
    return { approved: true, score: 10, issues: [], missingPieces: [] };
  }

  const allItems = [
    { ...hero, label: "HERO" },
    ...finalProducts.map((p, i) => ({ ...p, label: `ITEM ${i + 1}` })),
  ];

  // Fetch images in parallel (best-effort; missing image is OK)
  const imagePromises = allItems
    .filter(p => p.image)
    .map(async (p) => {
      const img = await fetchImageAsBase64(p.image);
      return img ? { ...img, label: p.label, title: p.title } : null;
    });
  const images = (await Promise.all(imagePromises)).filter(Boolean);

  const itemList = allItems.map(p => `${p.label}: "${p.title}"`).join("\n");

  const prompt = `You are a pragmatic fashion stylist reviewing an outfit curated from a CURATED LUXURY CATALOG (limited inventory). The inventory is what it is — your job is to approve outfits that work, not chase perfection.

OCCASION: ${occasion.label} — ${occasion.description}

OUTFIT PIECES:
${itemList}

WHAT MATTERS (deal-breakers — if any of these is wrong, reject):
1. Is the outfit COMPLETE? — needs a clear top half (top, blazer, dress) AND a bottom half (pants, skirt) OR a one-piece (dress, jumpsuit). Plus footwear. Missing one of these = reject.
2. Is anything FUNDAMENTALLY missing? (e.g., suit jacket alone with no shirt; blazer with no pants; evening look with no shoes)
3. Are there GLARING formality clashes? (e.g., flip-flops with formal blazer; sportswear in evening look; pajamas with stilettos)
4. Is the BAG appropriate for the occasion?
   - Evening / Date Night / Gala → small evening bag, clutch, pouch, slim portfolio (NOT briefcase, NOT backpack, NOT tote)
   - Office Ready → briefcase, work bag, structured tote, shoulder bag (NOT clutch, NOT evening pouch)
   - Vacation → tote, beach bag, relaxed shoulder bag (NOT briefcase, NOT clutch)
   - Casual → backpack, crossbody, shoulder bag (NOT clutch, NOT briefcase)
   - If the bag clearly mismatches the occasion → REJECT
5. Is the FOOTWEAR appropriate?
   - Evening → heels, oxfords, formal loafers (NOT sneakers, NOT flip-flops, NOT casual sandals)
   - Office → oxfords, derbies, pumps, ankle boots (NOT sneakers, NOT flip-flops)
   - Vacation → sandals, espadrilles, loafers (NOT formal heels, NOT formal oxfords)
   - Casual → sneakers, loafers, flat boots (anything goes within reason)

WHAT DOESN'T MATTER (do NOT reject for these — they are nitpicks):
- Bag size is "a bit large" but otherwise appropriate type
- Color harmony is "good but not perfect"
- Material weight differences (e.g., wool bag with silk shirt)
- "Could be more polished with a belt/pocket square/watch"
- Any subjective "could be better" remarks

SCORING:
- 9-10: perfect outfit
- 7-8: solid outfit with minor nitpicks (APPROVE)
- 5-6: acceptable outfit, has style notes worth mentioning (APPROVE)
- 3-4: missing something fundamental or has glaring clash (REJECT)
- 1-2: outfit doesn't work at all (REJECT)

Approve if score >= 5. Only REJECT for the deal-breakers above.

Respond ONLY with a JSON matching the schema.`;

  const parts = [];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
    parts.push(`(${img.label}: "${img.title}")`);
  }
  parts.push(prompt);

  try {
    const model = genAI.getGenerativeModel({
      model: CRITIC_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            score: { type: SchemaType.NUMBER, description: "1-10" },
            approved: { type: SchemaType.BOOLEAN, description: "true if score >= 5 and outfit is acceptable" },
            issues: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "List of issues with the outfit" },
            missingPieces: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: "Categories obviously missing, e.g., ['shirt', 'belt']. Use generic category names that match Shopify product types."
            },
            inappropriateItems: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.NUMBER },
              description: "1-based indexes of ITEMS that are inappropriate for this occasion and should be removed (e.g., briefcase in evening look). Use the ITEM N number from the OUTFIT PIECES list. Do NOT include the HERO. If nothing should be removed, return an empty array."
            },
            suggestion: { type: SchemaType.STRING, description: "Short suggestion for how to improve the outfit" }
          },
          required: ["score", "approved", "issues", "missingPieces", "inappropriateItems"]
        }
      }
    });

    const result = await model.generateContent(parts);
    const text = result.response.text();
    const verdict = JSON.parse(text);

    const flag = verdict.approved ? "✓" : "✗";
    console.log(`  [Critic] ${flag} score ${verdict.score}/10, approved: ${verdict.approved}${verdict.issues?.length ? ", issues: " + verdict.issues.join("; ") : ""}${verdict.missingPieces?.length ? ", missing: " + verdict.missingPieces.join(", ") : ""}`);
    return verdict;
  } catch (err) {
    console.log(`  [Critic] ⚠ Error (non-blocking): ${err.message}`);
    return { approved: true, score: 0, issues: [], missingPieces: [] };
  }
}

/**
 * Generate an outfit with mechanical validation + stylist critic + retries.
 *
 * Flow:
 *   1. Call Lambda CTL → get outfit
 *   2. Mechanical check: are all requested categories present?
 *   3. Stylist critic: does the outfit make sense visually + completely?
 *   4. If either check fails → retry Lambda (up to maxRetries)
 *   5. As a last resort → patch missing categories from debug candidates
 */
async function generateOutfit(product, { maxRetries = 5, occasion = null } = {}) {
  let bestData = null;
  let bestScore = -1;
  let bestVerdict = null;
  let totalDuration = 0;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    attempts++;
    const { data, duration } = await callLambdaOnce(product);
    totalDuration += duration;
    const { missingCategories, requestedCategories, finalProducts } = inspectOutfitCompleteness(data);

    // ── Stage 1: Mechanical check (Lambda dropped a category?) ──
    const mechanicallyComplete = missingCategories.length === 0;

    // ── Stage 2: Stylist critic (only if mechanically complete & we have an occasion) ──
    let verdict = { approved: true, score: 10, issues: [], missingPieces: [] };
    if (mechanicallyComplete && occasion && finalProducts.length > 0) {
      verdict = await criticOutfit(product, finalProducts, occasion);
    } else if (!mechanicallyComplete) {
      verdict = { approved: false, score: 0, issues: [`Lambda dropped categories: ${missingCategories.map(m => m.category).join(", ")}`], missingPieces: [] };
    }

    const ok = mechanicallyComplete && verdict.approved;
    if (ok) {
      console.log(`  ✓ Outfit approved on attempt ${attempts} (score ${verdict.score}/10, ${requestedCategories.length} categories)`);
      return { data, duration: totalDuration, attempts, patchedCategories: [], verdict };
    }

    // Track best attempt so far (highest critic score, fewest missing categories as tiebreak)
    const effectiveScore = mechanicallyComplete ? verdict.score : (verdict.score - missingCategories.length * 2);
    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestData = data;
      bestVerdict = verdict;
    }

    if (i < maxRetries) {
      const reason = mechanicallyComplete
        ? `critic rejected (score ${verdict.score}/10): ${verdict.issues.join("; ") || "outfit incoherent"}`
        : `mechanical: missing ${missingCategories.map(m => m.category).join(", ")}`;
      console.log(`  ⚠ Attempt ${attempts}/${maxRetries + 1} rejected — ${reason} — retrying...`);
      await delay(1500);
    }
  }

  // ── Fallback: patch missing categories from candidates ──
  const { missingCategories: stillMissing } = inspectOutfitCompleteness(bestData);
  const patchedCategories = [];
  if (stillMissing.length > 0) {
    const finalArr = bestData?.data?.outfits?.[0]?.products_for_outfit || [];
    const finalIds = new Set(finalArr.map(p => String(p.id)));

    for (const missing of stillMissing) {
      const pick = missing.candidates.find(c => !finalIds.has(c.id));
      if (pick) {
        finalArr.push({ id: pick.id, title: pick.title, image: pick.image, _patched: true });
        finalIds.add(pick.id);
        patchedCategories.push(missing.category);
      }
    }

    if (patchedCategories.length > 0 && bestData?.data?.outfits?.[0]) {
      bestData.data.outfits[0].products_for_outfit = finalArr;
      console.log(`  ⚠ Patched ${patchedCategories.length} missing category(ies) from candidates: ${patchedCategories.join(", ")}`);
    }
  }

  // ── Strip items the critic consistently flagged as inappropriate ──
  // (e.g., briefcase in evening look) when no better alternative was found.
  const removedItems = [];
  if (bestVerdict?.inappropriateItems?.length > 0 && bestData?.data?.outfits?.[0]?.products_for_outfit) {
    const finalArr = bestData.data.outfits[0].products_for_outfit;
    // inappropriateItems is 1-based ITEM N indexes (HERO is excluded).
    // Convert to 0-based indexes into finalArr.
    const indicesToRemove = bestVerdict.inappropriateItems
      .map(n => Number(n) - 1)
      .filter(i => Number.isInteger(i) && i >= 0 && i < finalArr.length);
    if (indicesToRemove.length > 0) {
      indicesToRemove.sort((a, b) => b - a); // remove from end to keep indexes valid
      for (const i of indicesToRemove) {
        const removed = finalArr.splice(i, 1)[0];
        if (removed) removedItems.push(removed.title || `item ${i + 1}`);
      }
      console.log(`  ⚠ Removed ${removedItems.length} inappropriate item(s) flagged by critic: ${removedItems.join(", ")}`);
    }
  }

  console.log(`  ⚠ Using best attempt after ${attempts} tries (score ${bestVerdict?.score || 0}/10, patched: ${patchedCategories.length}, removed: ${removedItems.length})`);
  return { data: bestData, duration: totalDuration, attempts, patchedCategories, verdict: bestVerdict, removedItems };
}

// ─── DynamoDB save ───────────────────────────────────────────────────

async function saveCuratedOutfits(outfits) {
  const cacheId = `naomi_curated_outfits_${SHOP_DOMAIN}`;
  const item = {
    id: cacheId,
    storeId: SHOP_DOMAIN,
    outfits,
    generatedAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };

  await dynamodb
    .put({ TableName: CACHE_TABLE, Item: item })
    .promise();

  console.log(`  Saved to DynamoDB: ${cacheId}`);
  return cacheId;
}

// ─── Shopify collections (homepage outfits) ─────────────────────────

let shopifyClient;

async function fetchAccessTokenFromDB(shopDomain) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shopDomain}`;
  const response = await fetch(url);
  const data = await response.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No accessToken found for "${shopDomain}"`);
  return token;
}

const OCCASION_HANDLES = {
  "date-night": "date-night-styled-by-naomi",
  "office-ready": "office-ready-styled-by-naomi",
  "vacation": "vacation-edit-styled-by-naomi",
  "casual": "casual-everyday-styled-by-naomi",
  "evening": "evening-events-styled-by-naomi",
};

const GET_COLLECTION_BY_HANDLE = gql`
  query getCollection($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
    }
  }
`;

const COLLECTION_REMOVE_PRODUCTS = gql`
  mutation collectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS = gql`
  mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE_SORT = gql`
  mutation collectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const COLLECTION_REORDER = gql`
  mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      userErrors { field message }
    }
  }
`;

const GET_COLLECTION_PRODUCTS = gql`
  query getCollectionProducts($id: ID!, $first: Int!) {
    collection(id: $id) {
      products(first: $first) {
        edges { node { id } }
      }
    }
  }
`;

function extractProductIds(outfitData) {
  const ids = [];
  try {
    const outfits = outfitData?.outfits || outfitData?.data?.outfits || [];
    for (const outfit of outfits) {
      const products = outfit.products_for_outfit || outfit.products || [];
      for (const p of products) {
        if (p.id) ids.push(String(p.id));
      }
    }
  } catch (e) { /* best effort */ }
  return ids;
}

// Order outfit products for display:
//   1. Hero first (the centerpiece chosen by Naomi)
//   2. Complements in the order Lambda returned them in products_for_outfit
//      (Lambda already searches categories in a logical order: top/bottom/footwear/accessory)
function sortOutfitForDisplay(heroId, finalProducts) {
  const heroIdStr = String(heroId);
  const heroEntry = { id: heroIdStr };
  const complements = finalProducts.filter(p => String(p.id) !== heroIdStr);
  return [heroEntry, ...complements];
}

async function refreshHomepageCollection(occasionId, heroId, outfitData) {
  const handle = OCCASION_HANDLES[occasionId];
  if (!handle) return;

  const { collectionByHandle } = await shopifyClient.request(GET_COLLECTION_BY_HANDLE, { handle });
  if (!collectionByHandle) {
    console.log(`    ⚠ Collection "${handle}" not found — run create-naomi-collections.js first`);
    return;
  }

  const collectionGid = collectionByHandle.id;

  // Build the new product set: hero first, then complements in Lambda's order
  const heroIdStr = String(heroId);
  const finalProducts = outfitData?.data?.outfits?.[0]?.products_for_outfit || [];
  const ordered = sortOutfitForDisplay(heroIdStr, finalProducts);

  const newProductGids = ordered.map(p => {
    const id = String(p.id);
    return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
  });
  const uniqueNewIds = [...new Set(newProductGids)];

  if (uniqueNewIds.length === 0) {
    console.log(`    ⚠ "${handle}": no products extracted from outfit — keeping existing collection contents intact`);
    return;
  }

  // Get existing products
  const { collection } = await shopifyClient.request(GET_COLLECTION_PRODUCTS, {
    id: collectionGid, first: 50,
  });
  const oldProductIds = (collection?.products?.edges || []).map(e => e.node.id);
  const oldSet = new Set(oldProductIds);
  const newSet = new Set(uniqueNewIds);

  // ── ADD FIRST (safe: collection grows but never empties) ──
  const idsToAdd = uniqueNewIds.filter(id => !oldSet.has(id));
  if (idsToAdd.length > 0) {
    const addRes = await shopifyClient.request(COLLECTION_ADD_PRODUCTS, {
      id: collectionGid, productIds: idsToAdd,
    });
    const addErrors = addRes?.collectionAddProducts?.userErrors || [];
    if (addErrors.length > 0) {
      throw new Error(`collectionAddProducts userErrors: ${JSON.stringify(addErrors)}`);
    }
  }

  // ── THEN REMOVE old products that aren't in the new set ──
  const idsToRemove = oldProductIds.filter(id => !newSet.has(id));
  if (idsToRemove.length > 0) {
    const remRes = await shopifyClient.request(COLLECTION_REMOVE_PRODUCTS, {
      id: collectionGid, productIds: idsToRemove,
    });
    const remErrors = remRes?.collectionRemoveProducts?.userErrors || [];
    if (remErrors.length > 0) {
      console.log(`    ⚠ "${handle}": remove userErrors: ${JSON.stringify(remErrors)} (continuing)`);
    }
  }

  // ── Reorder so hero is first ──
  try {
    await shopifyClient.request(COLLECTION_UPDATE_SORT, {
      input: { id: collectionGid, sortOrder: "MANUAL" },
    });
    const moves = uniqueNewIds.map((pid, i) => ({ id: pid, newPosition: String(i) }));
    await shopifyClient.request(COLLECTION_REORDER, {
      id: collectionGid, moves,
    });
  } catch (reorderErr) {
    // Reorder is cosmetic — products are already in collection. Just log.
    console.log(`    ⚠ "${handle}": reorder failed (${reorderErr.message}) — products are in collection but order may be wrong`);
  }

  console.log(`    Collection "${handle}" updated: ${uniqueNewIds.length} products (hero first), +${idsToAdd.length} added / -${idsToRemove.length} removed`);
}

// ─── Main ────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const accessToken = await fetchAccessTokenFromDB(SHOP_DOMAIN);
  shopifyClient = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  });

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Naomi Curated Outfits`);
  console.log(`  Store:    ${SHOP_DOMAIN}`);
  console.log(`  Mode:     ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Language: ${LANGUAGE}`);
  if (GEMINI_MODEL) console.log(`  Model:    ${GEMINI_MODEL}`);
  console.log(`  Occasions: ${OCCASIONS.length}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  const curatedOutfits = [];
  const stats = { occasions: 0, outfitsGenerated: 0, errors: 0, deduped: 0, patched: 0, criticRejected: 0, removed: 0 };
  const usedProductIds = new Set();

  for (const occasion of OCCASIONS) {
    console.log(`\n── ${occasion.label} ──`);
    console.log(`  "${occasion.description}"`);

    const occasionTag = occasion.id.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
    const mappedTag = {
      "date-night": "Date Night",
      "office-ready": "Office Ready",
      "vacation": "Vacation & Resort",
      "casual": "Casual Everyday",
      "evening": "Evening & Events",
    }[occasion.id] || occasionTag;

    console.log(`  Searching for Naomi picks with occasion: "${mappedTag}"...`);
    const candidates = await getNaomiPickCandidates(mappedTag);
    console.log(`  Found ${candidates.length} candidates`);

    if (candidates.length === 0) {
      console.log(`  ⚠ No candidates found — skipping`);
      stats.errors++;
      continue;
    }

    const availableCandidates = candidates.filter(c => !usedProductIds.has(String(c.id)));
    if (availableCandidates.length === 0) {
      console.log(`  ⚠ All candidates already used in other outfits — skipping`);
      stats.errors++;
      continue;
    }

    let hero = selectHero(availableCandidates, occasion.preferredCategories);
    console.log(`  Hero: "${hero.title}" [${hero.vendor}] (${hero.productType || "?"})`);
    usedProductIds.add(String(hero.id));

    if (dryRun) {
      console.log(`  [DRY RUN] Would call Complete The Look lambda for this hero`);
      curatedOutfits.push({
        occasion: occasion.id,
        label: occasion.label,
        description: occasion.description,
        hero: {
          id: hero.id,
          title: hero.title,
          handle: hero.handle,
          vendor: hero.vendor,
          productType: hero.productType,
          styleLane: hero.styleLane,
          image: hero.image,
          price: hero.price,
        },
        complements: [],
        generatedAt: new Date().toISOString(),
      });
      stats.outfitsGenerated++;
    } else {
      try {
        // Try the chosen hero. If Lambda returns empty/incomplete after retries,
        // rotate through other naomi:pick candidates of the same occasion.
        const heroAlternates = [hero, ...availableCandidates.filter(c => String(c.id) !== String(hero.id)).slice(0, 4)];
        let chosenHero = hero;
        let data, duration, attempts = 0, patchedCategories = [], verdict = null;
        let totalDuration = 0;

        for (let h = 0; h < heroAlternates.length; h++) {
          const candidateHero = heroAlternates[h];
          if (h > 0) {
            console.log(`  ⚠ Previous hero failed to produce a complete outfit — switching hero to "${candidateHero.title}"`);
          }
          console.log(`  Generating outfit via Complete The Look lambda for "${candidateHero.title}"...`);
          const result = await generateOutfit(candidateHero, { maxRetries: 5, occasion });
          totalDuration += result.duration || 0;
          data = result.data;
          attempts = result.attempts;
          patchedCategories = result.patchedCategories;
          verdict = result.verdict;
          chosenHero = candidateHero;
          if (result.removedItems?.length > 0) stats.removed += result.removedItems.length;

          const finalCount = data?.data?.outfits?.[0]?.products_for_outfit?.length || 0;
          if (finalCount >= 2) break; // accept if we have at least 2 products (hero + 1+ complement)
          console.log(`  ⚠ Hero "${candidateHero.title}" produced only ${finalCount} complement(s); trying next candidate...`);
        }

        // Update hero reference if we switched
        if (String(chosenHero.id) !== String(hero.id)) {
          usedProductIds.delete(String(hero.id));
          usedProductIds.add(String(chosenHero.id));
        }

        console.log(`  Outfit done in ${(totalDuration / 1000).toFixed(1)}s (final hero: "${chosenHero.title}", critic ${verdict?.score ?? "n/a"}/10)`);
        if (patchedCategories.length > 0) stats.patched += patchedCategories.length;
        if (verdict && !verdict.approved) stats.criticRejected++;

        const finalCount = data?.data?.outfits?.[0]?.products_for_outfit?.length || 0;
        if (finalCount === 0) {
          console.log(`  ✗ All hero candidates failed for ${occasion.id} — keeping previous collection contents intact`);
          stats.errors++;
          continue; // skip saving — refreshHomepageCollection will bail out anyway
        }

        // Replace `hero` reference for save below
        hero = chosenHero;

        curatedOutfits.push({
          occasion: occasion.id,
          label: occasion.label,
          description: occasion.description,
          hero: {
            id: hero.id,
            title: hero.title,
            handle: hero.handle,
            vendor: hero.vendor,
            productType: hero.productType,
            styleLane: hero.styleLane,
            image: hero.image,
            price: hero.price,
          },
          outfitData: data,
          attempts,
          patchedCategories,
          generatedAt: new Date().toISOString(),
        });
        stats.outfitsGenerated++;

        const complementIds = extractProductIds(data);
        const duplicates = complementIds.filter(id => usedProductIds.has(String(id)));
        if (duplicates.length > 0) {
          console.log(`    ⚠ ${duplicates.length} duplicate product(s) across outfits — regenerating...`);
          stats.deduped += duplicates.length;
        }
        complementIds.forEach(id => usedProductIds.add(String(id)));

        try {
          await refreshHomepageCollection(occasion.id, hero.id, data);
        } catch (collErr) {
          console.log(`    ✗ Collection update FAILED for ${occasion.id}: ${collErr.message}`);
          stats.errors++;
        }
      } catch (error) {
        console.error(`  ✗ ERROR: ${error.message}`);
        stats.errors++;
      }
    }

    stats.occasions++;
    await delay(2000);
  }

  if (!dryRun && curatedOutfits.length > 0) {
    console.log(`\n[Saving] Writing ${curatedOutfits.length} curated outfits to DynamoDB...`);
    const cacheId = await saveCuratedOutfits(curatedOutfits);
    console.log(`  Cache key: ${cacheId}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  RESULTS${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`    Occasions processed: ${stats.occasions}`);
    console.log(`    Outfits generated:   ${stats.outfitsGenerated}`);
    console.log(`    Unique products:     ${usedProductIds.size}`);
    if (stats.deduped > 0) console.log(`    Duplicates found:    ${stats.deduped}`);
    if (stats.patched > 0) console.log(`    Categories patched:  ${stats.patched} (Lambda dropped some, fallback used)`);
    if (stats.criticRejected > 0) console.log(`    Critic-rejected:     ${stats.criticRejected} (still saved best attempt)`);
    if (stats.removed > 0) console.log(`    Items removed:       ${stats.removed} (critic flagged as inappropriate, no alternative found)`);
    console.log(`    Errors:              ${stats.errors}`);
  if (curatedOutfits.length > 0) {
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  OUTFITS`);
    for (const outfit of curatedOutfits) {
      console.log(`    ${outfit.label}`);
      console.log(`      Hero: "${outfit.hero.title}" [${outfit.hero.vendor}]`);
    }
  }
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\nFatal error:", e);
    process.exit(1);
  });
