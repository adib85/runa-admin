import nodeFetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "@runa/config";
import { dynamoClient } from "@runa/core/database/dynamodb";

const DEMO_STORE_ID = "demo_searches";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await nodeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json,text/html,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseInputViaGemini(rawText) {
  if (!config.gemini?.apiKey) throw new Error("Missing GEMINI_API_KEY in env");
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const model = genAI.getGenerativeModel({
    model: config.gemini.liteModel,
    generationConfig: { responseMimeType: "application/json" },
  });

  const prompt = `Extract the outfits from the text below into structured JSON.

Each outfit has exactly one HERO product (the anchor) and one or more complementary product URLs.
Preserve the order of items as listed in the input — do NOT reorder.
Strip any trailing whitespace/newlines from URLs.
Skip any obvious duplicate URLs within the same outfit.

Return ONLY valid JSON, no markdown, in this exact shape:

{
  "domain": "example.com",
  "outfits": [
    { "hero": "https://...", "items": ["https://...", "https://..."] }
  ]
}

The "domain" field should be the bare hostname (no scheme, no www., no trailing slash) shared by all the URLs.

INPUT:
"""
${rawText}
"""`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}...`);
  }
}

function urlToHandle(productUrl) {
  const m = productUrl.match(/\/products\/([^/?#]+)/i);
  if (!m) throw new Error(`Cannot extract product handle from: ${productUrl}`);
  return m[1];
}

async function fetchStoreMeta(domain) {
  const res = await fetchWithTimeout(`https://${domain}/meta.json`);
  if (!res.ok) throw new Error(`/meta.json returned ${res.status} for ${domain}`);
  const data = await res.json();
  if (!data?.name) throw new Error(`No store name in /meta.json for ${domain}`);
  return { name: data.name };
}

async function fetchProductByHandle(domain, handle) {
  const url = `https://${domain}/products/${handle}.json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} → HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.product) throw new Error(`Empty product response for ${handle}`);
  return data.product;
}

async function fetchCollectionsCount(domain) {
  let count = 0;
  for (let page = 1; page <= 5; page++) {
    try {
      const res = await fetchWithTimeout(
        `https://${domain}/collections.json?limit=250&page=${page}`
      );
      if (!res.ok) break;
      const data = await res.json();
      const cols = data.collections || [];
      if (cols.length === 0) break;
      count += cols.filter((c) => (c.products_count || 0) > 0).length;
    } catch {
      break;
    }
  }
  return count;
}

async function fetchProductsCount(domain) {
  try {
    const res = await fetchWithTimeout(`https://${domain}/products.json?limit=250`);
    if (!res.ok) return 0;
    const data = await res.json();
    return (data.products || []).length;
  } catch {
    return 0;
  }
}

function buildAnchor(product) {
  const image = product.images?.[0]?.src || product.image?.src || null;
  const tags = Array.isArray(product.tags)
    ? product.tags
    : (product.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    type: product.product_type || "",
    vendor: product.vendor || "",
    tags,
    price: product.variants?.[0]?.price || "0.00",
    image,
    collection: (product.product_type || "all").toLowerCase().replace(/\s+/g, "-"),
  };
}

function buildItem(product) {
  const image = product.images?.[0]?.src || product.image?.src || null;
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    price: product.variants?.[0]?.price || "0.00",
    image,
    vendor: product.vendor || "",
    collection: (product.product_type || "all").toLowerCase().replace(/\s+/g, "-"),
  };
}

function buildOutfitObj(anchor, items, outfitName) {
  const total = [anchor, ...items].reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
  return { anchor, items, outfit_name: outfitName, total_price: total.toFixed(2) };
}

async function buildOutfitFromUrls({ domain, hero, items }, index) {
  const heroHandle = urlToHandle(hero);
  const itemHandles = items.map(urlToHandle);

  const anchorRaw = await fetchProductByHandle(domain, heroHandle);
  const itemRawProducts = [];
  for (const h of itemHandles) {
    const p = await fetchProductByHandle(domain, h);
    itemRawProducts.push(p);
  }

  return buildOutfitObj(buildAnchor(anchorRaw), itemRawProducts.map(buildItem), `Outfit ${index + 1}`);
}

async function saveDemoCache(domain, storeName, payload) {
  const docClient = dynamoClient.getDocClient();
  await docClient.send(
    new PutCommand({
      TableName: config.dynamodb.tables.cache,
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

/**
 * Run the full seed flow.
 *
 * @param {string} rawText  Free-form text with outfit URLs.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  If true, skip the DynamoDB write.
 * @param {(step: string) => void} [opts.onStep]  Optional progress callback.
 * @returns {Promise<{ payload: object, parsed: object, storeName: string }>}
 */
export async function seedDemoCache(rawText, opts = {}) {
  const { dryRun = false, onStep = () => {} } = opts;

  onStep("Parsing input via Gemini...");
  const parsed = await parseInputViaGemini(rawText);
  if (!parsed.domain || !parsed.outfits?.length) {
    throw new Error("Gemini returned no domain or no outfits");
  }
  const domain = parsed.domain.toLowerCase();

  onStep(`Fetching store meta for ${domain}...`);
  const meta = await fetchStoreMeta(domain);

  onStep("Fetching counts (collections + products)...");
  const [collectionCount, productCount] = await Promise.all([
    fetchCollectionsCount(domain),
    fetchProductsCount(domain),
  ]);

  onStep(`Building ${parsed.outfits.length} outfits...`);
  const outfits = [];
  for (const [i, o] of parsed.outfits.entries()) {
    const outfit = await buildOutfitFromUrls({ domain, ...o }, i);
    outfits.push(outfit);
  }

  const payload = {
    store: { name: meta.name, domain },
    outfit: outfits[0],
    alternativeOutfits: outfits.slice(1),
    productCount: productCount || 0,
    collectionCount: collectionCount || 0,
  };

  if (!dryRun) {
    onStep(`Saving cache for demo_${domain}...`);
    await saveDemoCache(domain, meta.name, payload);
  }

  return { payload, parsed, storeName: meta.name, domain, dryRun };
}
