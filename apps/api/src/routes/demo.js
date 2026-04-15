import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "@runa/config";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoClient } from "@runa/core/database/dynamodb";

const router = express.Router();

// ─── Prompt Defaults ─────────────────────────────────────────────────

const PROMPTS_KEY = "demo_prompts_config";

const DEFAULT_PROMPTS = {
  selectCollections: `You are a fashion stylist selecting collections from a store for outfit building.

Here are the store's collections:
{{collectionList}}

CRITICAL RULES:
- ONLY pick collections that represent PRODUCT CATEGORIES (e.g., "Dresses", "Trousers", "Shoes", "Sneakers", "Tops & Blouses", "Coats & Jackets", "Bags", "Jewellery", "Accessories", "Knitwear", "Skirts", "Sandals", "Boots", etc.)
- NEVER pick collections that are BRAND NAMES (e.g., "Gucci", "Acne Studios", "Max Mara", "Bottega Veneta", etc.)
- NEVER pick collections like "Gift Cards", "Sale", "All", "Home", "Bundles", "New Arrivals", "Best Sellers", "Activewear"
- If a collection title looks like a brand/designer name rather than a product category, SKIP it

Your task:
Pick 8-10 product category collections that are useful for outfit building. Include a MIX of:
- Clothing categories (dresses, tops, shirts, jackets, knitwear, coats, pants, skirts)
- Footwear categories (shoes, boots, sandals, sneakers)
- Accessories categories (bags, jewelry, belts, scarves)

Rank them by priority (best first).

Return ONLY valid JSON, no markdown:
{
  "collections": [{"handle": "...", "title": "...", "reason": "..."}]
}`,

  selectAnchors: `You are a fashion stylist selecting 3 anchor products for 3 different "Complete the Look" outfits for {{storeName}}.

CRITICAL: You MUST ONLY use products that exist in the data below. Copy the exact id, title, handle, price, and image from the data. NEVER invent products.

Here are the products grouped by collection:
{{allCollections}}

Your task:
Pick 3 anchor products for 3 DIFFERENT outfits. Each anchor must be:
- From a DIFFERENT collection/category (e.g., one dress, one top/jacket, one shoe/bag)
- Visually striking and photogenic
- Mid-to-high price range
- Has an image (not null)
- Versatile enough to pair with items from other collections

Ideal mix: 1 clothing piece (dress/coat/jacket), 1 different clothing piece (top/blouse/knitwear), 1 accessory or shoe.

Return ONLY valid JSON, no markdown:
{
  "anchors": [
    {"id": <number>, "title": "...", "handle": "...", "price": "...", "image": "...", "collection": "..."},
    {"id": <number>, "title": "...", "handle": "...", "price": "...", "image": "...", "collection": "..."},
    {"id": <number>, "title": "...", "handle": "...", "price": "...", "image": "...", "collection": "..."}
  ]
}`,

  buildOutfit: `You are an expert fashion stylist creating a "Complete the Look" outfit for {{storeName}}.

CRITICAL: You MUST ONLY use products that exist in the data below. Copy the exact id, title, handle, price, and image from the data. NEVER invent or fabricate products, prices, or image URLs.

===== ANCHOR PRODUCT =====
{{anchorProduct}}

===== AVAILABLE COLLECTIONS (pick 3-5 items from these to complete the look) =====
{{availableCollections}}

Your task:
Build a cohesive outfit around the anchor product above. Do NOT include the anchor product itself or any product similar to the anchor (same type/category). Pick 3-4 DIFFERENT items:
- Pick from 4 DIFFERENT collections
- ALWAYS include SHOES — every outfit needs footwear
- If the anchor is a DRESS: do NOT pick tops, corsets, bustiers, shirts, or blouses. Instead pick shoes, bags, jewelry, belts, scarves, or outerwear
- If the anchor is a TOP or BLOUSE: pick bottoms (pants/skirt), shoes, bags, jewelry
- If the anchor is a SHOE or BAG: pick clothing items (dress/top + bottom, or a full outfit) that match
- Consider color coordination and style coherence across all pieces
- Consider occasion matching (don't mix formal shoes with beach shorts, sportswear with evening wear)
- All items must feel like they belong to the SAME occasion and style
- Each item must have an image (image field is not null)
   - Return 3-4 items

Give the outfit a short name.

Return ONLY valid JSON, no markdown:
{
  "items": [
    {
      "id": <number>,
      "title": "...",
      "handle": "...",
      "price": "...",
      "image": "...",
      "collection": "...",
      "role": "bottom|shoes|bag|accessory|outerwear|jewelry|top|dress"
    }
  ],
  "outfit_name": "...",
  "total_price": "sum of all items INCLUDING the anchor"
}`,
};

async function loadPrompts() {
  try {
    const docClient = dynamoClient.getDocClient();
    const result = await docClient.send(new GetCommand({
      TableName: config.dynamodb.tables.cache,
      Key: { id: PROMPTS_KEY },
    }));
    if (result.Item?.prompts) {
      return { ...DEFAULT_PROMPTS, ...result.Item.prompts };
    }
  } catch (err) {
    console.error("Failed to load prompts, using defaults:", err.message);
  }
  return DEFAULT_PROMPTS;
}

// ─── Prompts CRUD ────────────────────────────────────────────────────

router.get("/prompts", async (req, res) => {
  const prompts = await loadPrompts();
  res.json({ prompts });
});

router.get("/prompts/defaults", (req, res) => {
  res.json({ prompts: DEFAULT_PROMPTS });
});

router.put("/prompts", async (req, res) => {
  try {
    const { prompts } = req.body;
    if (!prompts) return res.status(400).json({ error: "prompts object required" });

    const docClient = dynamoClient.getDocClient();
    await docClient.send(new PutCommand({
      TableName: config.dynamodb.tables.cache,
      Item: {
        id: PROMPTS_KEY,
        storeId: DEMO_STORE_ID,
        prompts,
        updatedAt: Date.now(),
      },
    }));
    res.json({ success: true });
  } catch (err) {
    console.error("Save prompts error:", err);
    res.status(500).json({ error: "Failed to save prompts" });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function normalizeDomain(input) {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/\/+$/, "");
  domain = domain.split("/")[0];
  return domain;
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function slimProduct(product, collectionHandle) {
  const image = product.images?.[0]?.src || product.image?.src || null;
  const tags = Array.isArray(product.tags)
    ? product.tags
    : (product.tags || "").split(",").map(t => t.trim()).filter(Boolean);
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    type: product.product_type || "",
    vendor: product.vendor || "",
    tags,
    price: product.variants?.[0]?.price || "0.00",
    image,
    collection: collectionHandle,
  };
}

// ─── Shopify Public API ──────────────────────────────────────────────

async function validateShopifyStore(domain) {
  try {
    const res = await fetchWithTimeout(`https://${domain}/meta.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.name ? { name: data.name, domain } : null;
  } catch {
    return null;
  }
}

async function fetchCollections(domain) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetchWithTimeout(
      `https://${domain}/collections.json?limit=250&page=${page}`
    );
    if (!res.ok) break;
    const data = await res.json();
    const collections = data.collections || [];
    if (collections.length === 0) break;
    all.push(...collections.map(c => ({
      handle: c.handle,
      title: c.title,
      image: c.image?.src || null,
    })));
  }
  if (all.length === 0) throw new Error("No collections found");
  return all;
}

async function fetchCollectionProducts(domain, handle, limit = 50) {
  try {
    const res = await fetchWithTimeout(
      `https://${domain}/collections/${handle}/products.json?limit=${limit}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.products || []).map(p => slimProduct(p, handle));
  } catch {
    return [];
  }
}

async function fetchAllProducts(domain, limit = 250) {
  try {
    const res = await fetchWithTimeout(
      `https://${domain}/products.json?limit=${limit}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.products || []).map(p => slimProduct(p, "all"));
  } catch {
    return [];
  }
}

// ─── Gemini Calls ────────────────────────────────────────────────────

function getGeminiModel(useLite = true) {
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  return genAI.getGenerativeModel({
    model: useLite ? config.gemini.liteModel : config.gemini.model,
  });
}

async function selectCollections(collections, prompts) {
  const model = getGeminiModel(true);
  const collectionList = collections
    .map((c, i) => `${i + 1}. "${c.title}" (handle: ${c.handle})`)
    .join("\n");

  const prompt = prompts.selectCollections
    .replace("{{collectionList}}", collectionList);

  const result = await model.generateContent(prompt);
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(text);
}

async function selectAnchors(allProducts, selectedCollections, storeName, prompts) {
  const model = getGeminiModel(true);
  const grouped = groupByCollection(allProducts, selectedCollections);
  const prompt = prompts.selectAnchors
    .replace("{{storeName}}", storeName)
    .replace("{{allCollections}}", formatGrouped(grouped));

  const result = await model.generateContent(prompt);
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(text);

  const productMap = new Map(allProducts.map(p => [p.id, p]));
  return (parsed.anchors || [])
    .filter(a => productMap.has(a.id))
    .map(a => {
      const real = productMap.get(a.id);
      return { ...a, title: real.title, handle: real.handle, price: real.price, image: real.image, vendor: real.vendor, collection: real.collection };
    });
}

function groupByCollection(products, selectedCollections) {
  const handleToTitle = {};
  const cols = selectedCollections?.collections || [...(selectedCollections?.main || []), ...(selectedCollections?.complementary || [])];
  cols.forEach(c => { handleToTitle[c.handle] = c.title; });

  const groups = {};
  for (const p of products) {
    const key = p.collection;
    if (!groups[key]) groups[key] = { title: handleToTitle[key] || key, products: [] };
    groups[key].products.push({
      id: p.id,
      title: p.title,
      handle: p.handle,
      type: p.type,
      price: p.price,
      tags: (p.tags || []).slice(0, 5),
      image: p.image,
    });
  }
  return groups;
}

function formatGrouped(groups) {
  return Object.entries(groups)
    .map(([handle, { title, products }]) =>
      `Collection "${title}" (${handle}):\n${JSON.stringify(products)}`
    )
    .join("\n\n");
}

async function fetchImageAsBase64(url) {
  try {
    const res = await fetchWithTimeout(url, 5000);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return { base64, contentType };
  } catch {
    return null;
  }
}

async function buildOutfitForAnchor(anchor, allProducts, storeName, prompts, selectedCollections) {
  const model = getGeminiModel(true);

  const complementary = allProducts.filter(p => p.id !== anchor.id && p.collection !== anchor.collection);
  const compGrouped = groupByCollection(complementary, selectedCollections);

  const anchorJson = JSON.stringify({ id: anchor.id, title: anchor.title, handle: anchor.handle, type: anchor.type, price: anchor.price, image: anchor.image, collection: anchor.collection });

  const prompt = prompts.buildOutfit
    .replace("{{storeName}}", storeName)
    .replace("{{anchorProduct}}", anchorJson)
    .replace("{{availableCollections}}", formatGrouped(compGrouped));

  // Fetch anchor image for Gemini
  const parts = [prompt];
  if (anchor.image) {
    const img = await fetchImageAsBase64(anchor.image);
    if (img) {
      parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
      parts.push(`(Image of anchor: "${anchor.title}")`);
    }
  }

  const result = await model.generateContent(parts);
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  const outfitData = JSON.parse(text);

  // Validate products exist in actual data
  const productMap = new Map(allProducts.map(p => [p.id, p]));

  const outfit = {
    anchor,
    items: (outfitData.items || [])
      .filter(item => productMap.has(item.id) && item.id !== anchor.id)
      .map(item => {
        const real = productMap.get(item.id);
        return { ...item, title: real.title, handle: real.handle, price: real.price, image: real.image, vendor: real.vendor };
      }),
    outfit_name: outfitData.outfit_name,
  };

  // Validate outfit coherence
  const dummyGrouped = groupByCollection([anchor], selectedCollections);
  const validatedOutfit = await validateOutfit(outfit, dummyGrouped, compGrouped, prompts, storeName);

  // Recalculate total
  if (validatedOutfit.anchor && validatedOutfit.items) {
    const total = [validatedOutfit.anchor, ...validatedOutfit.items]
      .reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
    validatedOutfit.total_price = total.toFixed(2);
  }

  return validatedOutfit;
}

async function validateOutfit(outfit, mainGrouped, compGrouped, prompts, storeName) {
  if (!outfit.anchor || !outfit.items?.length) return outfit;

  try {
    const validator = getGeminiModel(true);
    const anchorDesc = `"${outfit.anchor.title}" ($${outfit.anchor.price})`;
    const itemDescs = outfit.items.map((item, i) => `${i}: "${item.title}" (${item.role})`).join("\n");

    const valParts = [];

    // Send all product images for visual validation
    const allOutfitItems = [{ ...outfit.anchor, label: "ANCHOR" }, ...outfit.items.map((item, i) => ({ ...item, label: `ITEM ${i}` }))];
    const imagePromises = allOutfitItems
      .filter(p => p.image)
      .map(async (p) => {
        const img = await fetchImageAsBase64(p.image);
        return img ? { ...img, label: p.label, title: p.title } : null;
      });
    const images = (await Promise.all(imagePromises)).filter(Boolean);

    for (const img of images) {
      valParts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
      valParts.push(`(${img.label}: "${img.title}")`);
    }

    valParts.push(`You are a fashion expert reviewing an outfit for style coherence. Look at ALL the product images above.

Anchor product: ${anchorDesc}
Complementary items:
${itemDescs}

Which items DO NOT match the anchor? Consider:
- Redundant layering (corset/bustier/top over a dress — dresses don't need another top)
- Occasion mismatch (ski boots with cocktail dress, flip-flops with blazer, etc.)
- Season mismatch (winter coat with summer sandals)
- Style clash (sportswear with formal evening wear, denim patches on a cocktail outfit)
- Color clash (clashing patterns or colors that don't complement each other)
- Gender mismatch

Return ONLY valid JSON, no markdown:
{
  "remove": [0, 2],
  "verdict": "good" | "retry_with_different_anchor"
}

"remove": array of INDEX numbers of items to remove. Empty [] if all fine.
"verdict": "good" if the outfit works (even after removing some items), or "retry_with_different_anchor" if the anchor itself is problematic or the overall combination is unsalvageable and a completely different outfit should be tried.`
    );
    const valResult = await validator.generateContent(valParts);
    const valText = valResult.response.text().replace(/```json\n?|\n?```/g, "").trim();
    const validation = JSON.parse(valText);

    const removeIndexes = validation.remove || validation;
    const verdict = validation.verdict || "good";

    // If all fine, return as-is
    if ((!Array.isArray(removeIndexes) || removeIndexes.length === 0) && verdict === "good") {
      return outfit;
    }

    // Remove bad items
    if (Array.isArray(removeIndexes) && removeIndexes.length > 0) {
      const removeSet = new Set(removeIndexes);
      outfit.items = outfit.items.filter((_, i) => !removeSet.has(i));
    }

    // If verdict is good and enough items remain, keep it
    if (verdict === "good" && outfit.items.length >= 2) {
      return outfit;
    }

    // Retry with a completely different anchor
    console.log(`[Demo] Outfit validation: verdict="${verdict}", retrying with different anchor...`);
    const model = getGeminiModel(true);
    const retryPrompt = prompts.buildOutfit
      .replace("{{storeName}}", storeName)
      .replace("{{mainCollections}}", formatGrouped(mainGrouped))
      .replace("{{complementaryCollections}}", formatGrouped(compGrouped));

    const feedbackPrompt = `${retryPrompt}

IMPORTANT — PREVIOUS ATTEMPT FAILED:
The previous outfit with anchor "${outfit.anchor.title}" was rejected because the complementary items didn't match.
You MUST pick a DIFFERENT anchor product (not "${outfit.anchor.title}") and build a completely new outfit.
Pick an anchor that is easier to style — something versatile that pairs naturally with shoes, bags, and accessories.`;

    const retryResult = await model.generateContent(feedbackPrompt);
    const retryText = retryResult.response.text().replace(/```json\n?|\n?```/g, "").trim();
    const retryOutfit = JSON.parse(retryText);

    // Validate retry against real products
    const allGrouped = { ...mainGrouped, ...compGrouped };
    const allProducts = Object.values(allGrouped).flatMap(g => g.products);
    const productMap = new Map(allProducts.map(p => [p.id, p]));

    if (retryOutfit.anchor?.id && productMap.has(retryOutfit.anchor.id)) {
      const real = productMap.get(retryOutfit.anchor.id);
      retryOutfit.anchor = { ...retryOutfit.anchor, title: real.title, handle: real.handle, price: real.price, image: real.image, vendor: real.vendor };
    }
    if (retryOutfit.items) {
      retryOutfit.items = retryOutfit.items
        .filter(item => productMap.has(item.id))
        .map(item => {
          const real = productMap.get(item.id);
          return { ...item, title: real.title, handle: real.handle, price: real.price, image: real.image, vendor: real.vendor };
        });
    }

    // Final validation (no more retries)
    if (retryOutfit.anchor && retryOutfit.items?.length > 0) {
      try {
        const val2 = getGeminiModel(true);
        const anchorDesc2 = `"${retryOutfit.anchor.title}" ($${retryOutfit.anchor.price})`;
        const itemDescs2 = retryOutfit.items.map((item, i) => `${i}: "${item.title}" (${item.role})`).join("\n");
        const val2Result = await val2.generateContent(
          `You are a fashion expert. Does this outfit make sense?
Anchor: ${anchorDesc2}
Items:
${itemDescs2}
Return ONLY a JSON array of INDEX numbers of items to REMOVE for style/occasion/season mismatch. Return [] if all fine.`
        );
        const val2Text = val2Result.response.text().replace(/```json\n?|\n?```/g, "").trim();
        const removeIndexes2 = JSON.parse(val2Text);
        if (Array.isArray(removeIndexes2) && removeIndexes2.length > 0) {
          const removeSet2 = new Set(removeIndexes2);
          retryOutfit.items = retryOutfit.items.filter((_, i) => !removeSet2.has(i));
        }
      } catch (err) {
        console.error("Retry validation failed (non-blocking):", err.message);
      }
    }

    return retryOutfit;
  } catch (err) {
    console.error("Outfit validation failed (non-blocking):", err.message);
    return outfit;
  }
}

// ─── DynamoDB Cache ──────────────────────────────────────────────────

const DEMO_STORE_ID = "demo_searches";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getCachedResult(domain) {
  try {
    const docClient = dynamoClient.getDocClient();
    const result = await docClient.send(new GetCommand({
      TableName: config.dynamodb.tables.cache,
      Key: { id: `demo_${domain}` },
    }));
    return result.Item?.result || null;
  } catch {
    return null;
  }
}

async function deleteCachedResult(domain) {
  try {
    const docClient = dynamoClient.getDocClient();
    await docClient.send(new DeleteCommand({
      TableName: config.dynamodb.tables.cache,
      Key: { id: `demo_${domain}` },
    }));
    return true;
  } catch {
    return false;
  }
}

async function saveDemoResult(domain, storeName, resultData) {
  try {
    const docClient = dynamoClient.getDocClient();
    await docClient.send(new PutCommand({
      TableName: config.dynamodb.tables.cache,
      Item: {
        id: `demo_${domain}`,
        storeId: DEMO_STORE_ID,
        domain,
        storeName,
        result: resultData,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
  } catch (err) {
    console.error("Demo save error:", err.message);
  }
}

async function logDemoSearch(domain, storeName, fromCache, ip) {
  try {
    const docClient = dynamoClient.getDocClient();
    const existing = await docClient.send(new GetCommand({
      TableName: config.dynamodb.tables.cache,
      Key: { id: `demo_visits_${domain}` },
    }));

    const visits = existing.Item?.visits || [];
    visits.unshift({
      time: Date.now(),
      fromCache,
      ip: ip || "unknown",
    });

    await docClient.send(new PutCommand({
      TableName: config.dynamodb.tables.cache,
      Item: {
        id: `demo_visits_${domain}`,
        storeId: DEMO_STORE_ID,
        domain,
        storeName,
        visits: visits.slice(0, 50),
        totalVisits: (existing.Item?.totalVisits || 0) + 1,
        lastVisit: Date.now(),
      },
    }));
  } catch (err) {
    console.error("Search log error:", err.message);
  }
}

// ─── List Demo Searches ──────────────────────────────────────────────

router.get("/searches", async (req, res) => {
  try {
    const docClient = dynamoClient.getDocClient();
    const results = [];
    let lastKey = undefined;

    do {
      const response = await docClient.send(new QueryCommand({
        TableName: config.dynamodb.tables.cache,
        IndexName: "storeId-index",
        KeyConditionExpression: "storeId = :sid",
        ExpressionAttributeValues: { ":sid": DEMO_STORE_ID },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      results.push(...(response.Items || []));
      lastKey = response.LastEvaluatedKey;
    } while (lastKey);

    const outfitsByDomain = {};
    results
      .filter(r => r.id?.startsWith("demo_") && !r.id.startsWith("demo_visits_") && !r.id.startsWith("demo_prompts") && r.result)
      .forEach(r => {
        outfitsByDomain[r.domain] = r.result?.outfit;
      });

    const stores = results
      .filter(r => r.id?.startsWith("demo_visits_"))
      .map(r => ({
        domain: r.domain,
        storeName: r.storeName,
        visits: (r.visits || []).slice(0, 10),
        totalVisits: r.totalVisits || 0,
        lastVisit: r.lastVisit,
        cachedHits: (r.visits || []).filter(v => v.fromCache).length,
        freshHits: (r.visits || []).filter(v => !v.fromCache).length,
      }))
      .sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));

    const totalSearches = stores.reduce((sum, s) => sum + s.totalVisits, 0);

    res.json({
      cached: Object.keys(outfitsByDomain).length,
      totalSearches,
      totalStores: stores.length,
      outfitsByDomain,
      stores,
    });
  } catch (err) {
    console.error("List demo searches error:", err);
    res.status(500).json({ error: "Failed to fetch demo searches" });
  }
});

// ─── Cache Management ────────────────────────────────────────────────

router.delete("/cache/:domain", async (req, res) => {
  const ok = await deleteCachedResult(req.params.domain);
  res.json({ success: ok, domain: req.params.domain });
});

router.delete("/cache", async (req, res) => {
  try {
    const docClient = dynamoClient.getDocClient();
    const results = [];
    let lastKey;
    do {
      const response = await docClient.send(new QueryCommand({
        TableName: config.dynamodb.tables.cache,
        IndexName: "storeId-index",
        KeyConditionExpression: "storeId = :sid",
        ExpressionAttributeValues: { ":sid": DEMO_STORE_ID },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      results.push(...(response.Items || []));
      lastKey = response.LastEvaluatedKey;
    } while (lastKey);

    const cached = results.filter(r => !r.type && r.result);
    await Promise.all(cached.map(r =>
      docClient.send(new DeleteCommand({
        TableName: config.dynamodb.tables.cache,
        Key: { id: r.id },
      }))
    ));
    res.json({ success: true, deleted: cached.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear cache" });
  }
});

// ─── Main SSE Endpoint ──────────────────────────────────────────────

router.get("/analyze", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  if (!config.gemini.apiKey) {
    return res.status(500).json({ error: "Gemini API key not configured" });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const domain = normalizeDomain(url);

  try {
    // Step 0: Validate
    sendSSE(res, "status", { step: "validate", message: `Connecting to ${domain}...` });
    const store = await validateShopifyStore(domain);
    if (!store) {
      sendSSE(res, "error", {
        message: "This doesn't appear to be a Shopify store, or it's not publicly accessible.",
      });
      return res.end();
    }
    sendSSE(res, "status", { step: "validate", message: `Connected to ${store.name}` });

    // Load prompts from DB
    const prompts = await loadPrompts();

    // Step 1: Fetch collections
    sendSSE(res, "status", { step: "scan", message: "Scanning product catalog..." });
    let collections;
    try {
      collections = await fetchCollections(domain);
    } catch {
      collections = [];
    }

    let useCollectionApproach = collections.length >= 3;

    if (useCollectionApproach) {
      sendSSE(res, "status", {
        step: "scan",
        message: `Found ${collections.length} collections`,
      });

      // Step 2: Gemini #1 — Select collections (still scan phase visually)
      sendSSE(res, "status", { step: "scan", message: "Analyzing collections..." });
      let selectedCollections;
      try {
        selectedCollections = await selectCollections(collections, prompts);
      } catch (err) {
        console.error("Gemini collection selection failed:", err.message);
        useCollectionApproach = false;
      }

      if (useCollectionApproach) {
        const allHandles = (selectedCollections.collections || []).map(c => c.handle);

        sendSSE(res, "status", {
          step: "scan",
          message: `Selected ${allHandles.length} collections for styling`,
        });

        // Step 3: Fetch products from selected collections in parallel
        sendSSE(res, "status", { step: "scan", message: "Loading products..." });

        const productResults = await Promise.all(
          allHandles.map(handle => fetchCollectionProducts(domain, handle, 50))
        );

        // Flatten and drop empty collections
        let allProducts = [];
        const validHandles = [];

        allHandles.forEach((handle, i) => {
          const products = productResults[i];
          if (products.length >= 3) {
            allProducts.push(...products);
            validHandles.push(handle);
          }
        });

        if (validHandles.length < 3) {
          useCollectionApproach = false;
        } else {
          const totalProducts = allProducts.length;
          const collectionTitles = {};
          for (const c of (selectedCollections.collections || [])) {
            collectionTitles[c.handle] = c.title;
          }

          // Build preview images (round-robin from all collections)
          const byCollection = {};
          for (const p of allProducts) {
            if (!p.image) continue;
            if (!byCollection[p.collection]) byCollection[p.collection] = [];
            byCollection[p.collection].push(p.image);
          }
          const allCollectionImages = Object.values(byCollection);
          const previewRows = [];
          let idx = 0;
          while (previewRows.length < 24 && idx < 10) {
            for (const col of allCollectionImages) {
              if (idx < col.length && previewRows.length < 24) {
                previewRows.push(col[idx]);
              }
            }
            idx++;
          }

          sendSSE(res, "status", {
            step: "classify",
            message: `Found ${totalProducts} products across ${validHandles.length} collections`,
            productCount: totalProducts,
            previewImages: previewRows,
          });

          // Step 4: Check cache or build outfits
          const skipCaching = req.query.skipCaching === "true";
          const cached = skipCaching ? null : await getCachedResult(domain);
          let completeData;

          if (cached) {
            await sleep(5000);
            completeData = cached;
            logDemoSearch(domain, store.name, true, req.ip).catch(() => {});
          } else {
            // Gemini #2: Select 3 anchors from different categories
            const anchors = await selectAnchors(allProducts, selectedCollections, store.name, prompts);

            if (anchors.length === 0) {
              useCollectionApproach = false;
            } else {
              // Gemini #3: Build outfits in parallel (one per anchor)
              const outfitPromises = anchors.slice(0, 3).map(anchor =>
                buildOutfitForAnchor(anchor, allProducts, store.name, prompts, selectedCollections)
                  .catch(err => {
                    console.error(`[Demo] Outfit build failed for ${anchor.title}:`, err.message);
                    return null;
                  })
              );
              const outfits = (await Promise.all(outfitPromises)).filter(Boolean);

              if (outfits.length === 0) {
                useCollectionApproach = false;
              } else {
                completeData = {
                  store: { name: store.name, domain },
                  outfit: outfits[0],
                  alternativeOutfits: outfits.slice(1),
                  productCount: totalProducts,
                  collectionCount: validHandles.length,
                };
                saveDemoResult(domain, store.name, completeData).catch(() => {});
                logDemoSearch(domain, store.name, false, req.ip).catch(() => {});
              }
            }
          }

          if (completeData) {
            sendSSE(res, "complete", completeData);
            return res.end();
          }
        }
      }
    }

    // ─── Fallback: flat product list ────────────────────────────────
    sendSSE(res, "status", {
      step: "scan",
      message: collections.length < 3
        ? "Few collections found, scanning all products..."
        : "Retrying with full product catalog...",
    });

    const allProducts = await fetchAllProducts(domain, 250);
    if (allProducts.length === 0) {
      sendSSE(res, "error", {
        message: "No products found. The store may be empty or access is restricted.",
      });
      return res.end();
    }

    sendSSE(res, "status", {
      step: "scan",
      message: `Found ${allProducts.length} products`,
      productCount: allProducts.length,
    });

    // Fallback: pick first good product as anchor, build one outfit
    const anchor = allProducts.find(p => p.image);
    if (!anchor) {
      sendSSE(res, "error", { message: "No suitable products found for styling." });
      return res.end();
    }

    const outfit = await buildOutfitForAnchor(anchor, allProducts, store.name, prompts, null);

    const completeData = {
      store: { name: store.name, domain },
      outfit,
      alternativeOutfits: [],
      productCount: allProducts.length,
      collectionCount: collections.length,
    };
    sendSSE(res, "complete", completeData);
    saveDemoResult(domain, store.name, completeData).catch(() => {});
    logDemoSearch(domain, store.name, false, req.ip).catch(() => {});
    res.end();
  } catch (err) {
    console.error("Demo analyze error:", err);
    sendSSE(res, "error", { message: "Something went wrong. Please try again." });
    res.end();
  }
});

export default router;
