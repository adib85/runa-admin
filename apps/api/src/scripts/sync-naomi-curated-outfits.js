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
    label: "Date Night — styled by Naomi",
    tag: "naomi:date-night",
    preferredCategories: ["dresses", "tops & blouses", "skirts", "jumpsuits & playsuits"],
    description: "Romantic dinner, cocktails, an intimate evening out",
  },
  {
    id: "office-ready",
    label: "Office Ready — styled by Naomi",
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
    label: "Casual Everyday — styled by Naomi",
    tag: "naomi:casual",
    preferredCategories: ["knitwear", "jeans", "t-shirts & vests", "sneakers", "t-shirts & polos"],
    description: "Weekend brunch, errands, relaxed daily wear",
  },
  {
    id: "evening",
    label: "Evening & Events — styled by Naomi",
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

async function generateOutfit(product) {
  const url = buildLambdaUrl(product);
  const startTime = Date.now();

  const response = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  const duration = Date.now() - startTime;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return { data, duration };
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

async function refreshHomepageCollection(occasionId, heroId, outfitData) {
  const handle = OCCASION_HANDLES[occasionId];
  if (!handle) return;

  const { collectionByHandle } = await shopifyClient.request(GET_COLLECTION_BY_HANDLE, { handle });
  if (!collectionByHandle) {
    console.log(`    ⚠ Collection "${handle}" not found — run create-naomi-collections.js first`);
    return;
  }

  const collectionGid = collectionByHandle.id;

  const { collection } = await shopifyClient.request(GET_COLLECTION_PRODUCTS, {
    id: collectionGid, first: 50,
  });
  const oldProductIds = (collection?.products?.edges || []).map(e => e.node.id);

  if (oldProductIds.length > 0) {
    await shopifyClient.request(COLLECTION_REMOVE_PRODUCTS, {
      id: collectionGid, productIds: oldProductIds,
    });
  }

  const complementIds = extractProductIds(outfitData);
  const allIds = [heroId, ...complementIds]
    .map(id => id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`);

  const uniqueIds = [...new Set(allIds)];

  if (uniqueIds.length > 0) {
    await shopifyClient.request(COLLECTION_ADD_PRODUCTS, {
      id: collectionGid, productIds: uniqueIds,
    });
  }

  console.log(`    Collection "${handle}" updated: ${uniqueIds.length} products`);
}

// ─── Main ────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const accessToken = await fetchAccessTokenFromDB(SHOP_DOMAIN);
  shopifyClient = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2023-04/graphql.json`, {
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
  const stats = { occasions: 0, outfitsGenerated: 0, errors: 0 };

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

    const hero = selectHero(candidates, occasion.preferredCategories);
    console.log(`  Hero: "${hero.title}" [${hero.vendor}] (${hero.productType || "?"})`);

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
        console.log(`  Generating outfit via Complete The Look lambda...`);
        const { data, duration } = await generateOutfit(hero);
        console.log(`  Outfit generated in ${(duration / 1000).toFixed(1)}s`);

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
          generatedAt: new Date().toISOString(),
        });
        stats.outfitsGenerated++;

        try {
          await refreshHomepageCollection(occasion.id, hero.id, data);
        } catch (collErr) {
          console.log(`    ⚠ Collection update failed: ${collErr.message}`);
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
