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
- ONLY pick collections with at least 5 products (check the product count)
- GENDER RULE: Look at collection titles AND handles. If you see both men's and women's collections (e.g., "Mens: Shirts" vs "Womens: Shirts", or handles like "mens-belts" vs "womens-belts"), you MUST pick ONLY women's collections. NEVER pick any collection with "mens", "men", "homme", "uomo" in the title or handle. Pick the women's equivalent instead (e.g., pick "womens-belts" not "mens-belts").
- If the store is men-only (no women's collections), pick men's collections.

Your task:
Pick 8-10 product category collections that are useful for outfit building. All from the SAME gender (prefer women's if both available). Include a MIX of:
- Clothing categories (dresses, tops, shirts, jackets, knitwear, coats, pants, skirts)
- Footwear categories (shoes, boots, sandals, sneakers)
- Accessories categories (bags, jewelry, belts, scarves)

Rank them by priority (best first).

Return ONLY valid JSON, no markdown:
{
  "collections": [{"handle": "...", "title": "...", "reason": "..."}]
}`,

  selectAnchors: `You are a fashion stylist selecting 5 anchor products for different "Complete the Look" outfits for {{storeName}}.

CRITICAL: You MUST ONLY use products that exist in the data below. Copy the exact id, title, handle, price, and image from the data. NEVER invent products.

Here are the products grouped by collection:
{{allCollections}}

Your task:
Pick 5 anchor products for 5 DIFFERENT outfits. Each anchor must be:
- From a DIFFERENT collection/category (e.g., one dress, one top/jacket, one shoe/bag)
- Visually striking and photogenic
- Mid-to-high price range
- Has an image (not null)
- Versatile enough to pair with items from other collections

Ideal mix: 2 clothing pieces (dress, coat/jacket, top/blouse), 1-2 accessories or shoes, 1 knitwear/outerwear. All from DIFFERENT collections.

Return ONLY valid JSON, no markdown. Return ONLY the product IDs:
{
  "anchors": [<id1>, <id2>, <id3>, <id4>, <id5>]
}`,

  buildOutfit: `You are an expert fashion stylist creating a "Complete the Look" outfit for {{storeName}}.

CRITICAL: You MUST ONLY use products that exist in the data below. Copy the exact id, title, handle, price, and image from the data. NEVER invent or fabricate products, prices, or image URLs.

===== ANCHOR PRODUCT =====
{{anchorProduct}}

===== AVAILABLE COLLECTIONS (pick 3-5 items from these to complete the look) =====
{{availableCollections}}

Your task:
Build a cohesive outfit around the anchor product above. RULES:
- Do NOT pick any product that is the same TYPE as the anchor (no dress with dress, no coat with coat, no shoe with shoe)
- Do NOT pick the anchor product itself
- Pick 3-4 DIFFERENT items from DIFFERENT categories:
- Pick from 4 DIFFERENT collections
- ALWAYS include SHOES — every outfit needs footwear
- If the anchor is a DRESS: do NOT pick tops, corsets, bustiers, shirts, or blouses. Instead pick shoes, bags, jewelry, belts, scarves, or outerwear
- If the anchor is a TOP or BLOUSE: pick bottoms (pants/skirt), shoes, bags, jewelry
- If the anchor is a SHOE or BAG: pick clothing items (dress/top + bottom, or a full outfit) that match
- Consider color coordination and style coherence across all pieces
- Consider occasion matching (don't mix formal shoes with beach shorts, sportswear with evening wear)
- All items must feel like they belong to the SAME occasion and style
- Each item must have an image (image field is not null)
   - You MUST return exactly 3 or 4 item IDs. NEVER return fewer than 3.

Give the outfit a short name.

IMPORTANT: You MUST return exactly 3 or 4 product IDs in the items array. NEVER return fewer than 3 items. If you cannot find 3 items, try harder.

Return ONLY valid JSON, no markdown. Return ONLY the product IDs:
{
  "items": [<id1>, <id2>, <id3>, <id4>],
  "outfit_name": "..."
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

// ─── Debug Tracker ───────────────────────────────────────────────────

class DebugTracker {
  constructor(enabled) {
    this.enabled = enabled;
    this.calls = [];
    this.startTime = Date.now();
  }

  track(name, { inputTokens, outputTokens, inputChars, rawResponse, elapsed }) {
    if (!this.enabled) return;
    this.calls.push({
      name,
      elapsed: `${elapsed}ms`,
      inputTokens,
      outputTokens,
      inputChars,
      rawResponse: rawResponse?.substring(0, 500),
      timestamp: Date.now() - this.startTime,
    });
  }

  getData() {
    if (!this.enabled) return undefined;
    const totalInput = this.calls.reduce((s, c) => s + (c.inputTokens || 0), 0);
    const totalOutput = this.calls.reduce((s, c) => s + (c.outputTokens || 0), 0);
    return {
      totalTime: `${Date.now() - this.startTime}ms`,
      totalCalls: this.calls.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      calls: this.calls,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function normalizeDomain(input) {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/^www\./, "");
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
      productsCount: c.products_count || 0,
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

async function selectCollections(collections, prompts, debug) {
  const model = getGeminiModel(true);
  const collectionList = collections
    .map((c, i) => `${i + 1}. "${c.title}" (handle: ${c.handle}, ${c.productsCount} products)`)
    .join("\n");

  const prompt = prompts.selectCollections
    .replace("{{collectionList}}", collectionList);

  const t = Date.now();
  const result = await model.generateContent(prompt);
  const u = result.response.usageMetadata;
  debug.track("selectCollections", { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, inputChars: prompt.length, rawResponse: result.response.text(), elapsed: Date.now() - t });
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(text);
}

async function selectAnchors(allProducts, selectedCollections, storeName, prompts, debug) {
  const model = getGeminiModel(true);
  const grouped = groupByCollection(allProducts, selectedCollections);
  const prompt = prompts.selectAnchors
    .replace("{{storeName}}", storeName)
    .replace("{{allCollections}}", formatGrouped(grouped));

  const t = Date.now();
  const result = await model.generateContent(prompt);
  const u = result.response.usageMetadata;
  debug.track("selectAnchors", { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, inputChars: prompt.length, rawResponse: result.response.text(), elapsed: Date.now() - t });
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(text);

  const productMap = new Map(allProducts.map(p => [p.id, p]));
  const anchorIds = parsed.anchors || [];
  return anchorIds
    .filter(id => productMap.has(id))
    .map(id => productMap.get(id));
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
      price: p.price,
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

async function buildOutfitForAnchor(anchor, allProducts, storeName, prompts, selectedCollections, debug) {
  const model = getGeminiModel(true);

  const complementary = allProducts.filter(p =>
    p.id !== anchor.id &&
    p.collection !== anchor.collection &&
    p.type !== anchor.type
  );
  const compGrouped = groupByCollection(complementary, selectedCollections);

  const anchorJson = JSON.stringify({ id: anchor.id, title: anchor.title, type: anchor.type, price: anchor.price, collection: anchor.collection });

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

  const t = Date.now();
  const result = await model.generateContent(parts);
  const u = result.response.usageMetadata;
  debug.track(`buildOutfit "${anchor.title}"`, { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, inputChars: prompt.length, rawResponse: result.response.text(), elapsed: Date.now() - t });
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  const outfitData = JSON.parse(text);

  const productMap = new Map(allProducts.map(p => [p.id, p]));
  const itemIds = outfitData.items || [];
  const validIds = itemIds.filter(id => productMap.has(id) && id !== anchor.id);

  const outfit = {
    anchor,
    items: validIds
      .map(id => {
        const p = productMap.get(id);
        return { id: p.id, title: p.title, handle: p.handle, price: p.price, image: p.image, vendor: p.vendor, collection: p.collection };
      }),
    outfit_name: outfitData.outfit_name,
  };

  // Skip heavy validation — the type/collection filtering + good prompts handle quality
  const validatedOutfit = outfit;

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

    // Send only anchor image for validation
    if (outfit.anchor.image) {
      const img = await fetchImageAsBase64(outfit.anchor.image);
      if (img) {
        valParts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
        valParts.push(`(Anchor: "${outfit.anchor.title}")`);
      }
    }

    valParts.push(`You are a fashion expert reviewing an outfit for style coherence. The anchor product image is shown above.

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
    console.log(`[PERF] validation "${outfit.anchor.title}": ${valParts.length} parts`);
    const vt = Date.now();
    const valResult = await validator.generateContent(valParts);
    console.log(`[PERF] validation "${outfit.anchor.title}": ${Date.now()-vt}ms`);
    const valText = valResult.response.text().replace(/```json\n?|\n?```/g, "").trim();
    console.log(`[DEBUG] validation "${outfit.anchor.title}" response:`, valText);
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
    const retryData = JSON.parse(retryText);

    // Validate retry against real products
    const allGrouped = { ...mainGrouped, ...compGrouped };
    const allProducts = Object.values(allGrouped).flatMap(g => g.products);
    const productMap = new Map(allProducts.map(p => [p.id, p]));

    const retryItemIds = retryData.items || [];
    const retryOutfit = {
      anchor: outfit.anchor,
      items: retryItemIds
        .filter(id => productMap.has(id) && id !== outfit.anchor.id)
        .map(id => {
          const p = productMap.get(id);
          return { id: p.id, title: p.title, handle: p.handle, price: p.price, image: p.image, vendor: p.vendor, collection: p.collection };
        }),
      outfit_name: retryData.outfit_name,
    };

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
  const isDebug = req.query.debug === "true";
  const debug = new DebugTracker(isDebug);

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

    // Filter out empty collections before sending to Gemini
    let collectionsWithProducts = collections.filter(c => c.productsCount >= 5);

    // If store has gendered collections, keep only the dominant gender
    const womensCollections = collectionsWithProducts.filter(c => /women|femme|donna|damen/i.test(c.title + ' ' + c.handle));
    const mensCollections = collectionsWithProducts.filter(c => /\bmen\b|mens|homme|uomo|herren/i.test(c.title + ' ' + c.handle) && !/women|femme|donna|damen/i.test(c.title + ' ' + c.handle));

    if (womensCollections.length > 0 && mensCollections.length > 0) {
      const keepGender = womensCollections.length >= mensCollections.length ? 'women' : 'men';
      const filtered = collectionsWithProducts.filter(c => {
        const text = (c.title + ' ' + c.handle).toLowerCase();
        if (keepGender === 'women') {
          return !(/(^|\b)mens?\b|homme|uomo|herren/.test(text) && !/women|femme|donna|damen/.test(text));
        } else {
          return !(/(women|femme|donna|damen)/.test(text) && !/(^|\b)mens?\b|homme|uomo|herren/.test(text));
        }
      });
      if (filtered.length >= 5) collectionsWithProducts = filtered;
    }
    let useCollectionApproach = collectionsWithProducts.length >= 3;

    if (useCollectionApproach) {
      sendSSE(res, "status", {
        step: "scan",
        message: `Found ${collectionsWithProducts.length} collections with products`,
      });

      // Step 2: Gemini #1 — Select collections (still scan phase visually)
      sendSSE(res, "status", { step: "scan", message: "Analyzing collections..." });
      let selectedCollections;
      try {
        selectedCollections = await selectCollections(collectionsWithProducts, prompts, debug);
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
            // Gemini #2: Select anchors from different categories (ask for 5 to have backups)
            const anchors = await selectAnchors(allProducts, selectedCollections, store.name, prompts, debug);

            if (anchors.length === 0) {
              useCollectionApproach = false;
            } else {
              const outfits = [];
              const usedAnchorIds = new Set();
              const candidates = anchors.slice(0, 5);

              // Build outfits in parallel, first batch of 3
              const firstBatch = candidates.slice(0, 3).map(anchor =>
                buildOutfitForAnchor(anchor, allProducts, store.name, prompts, selectedCollections, debug)
                  .then(o => {
                    if (o?.anchor?.image && o?.anchor?.title && o?.items?.length >= 2) {
                      usedAnchorIds.add(o.anchor.id);
                      return o;
                    }
                    return null;
                  })
                  .catch(err => {
                    console.error(`[Demo] Outfit build failed for ${anchor.title}:`, err.message);
                    return null;
                  })
              );
              const firstResults = (await Promise.all(firstBatch)).filter(Boolean);
              outfits.push(...firstResults);

              // If fewer than 3 valid outfits, try backup anchors
              if (outfits.length < 3 && candidates.length > 3) {
                const backups = candidates.slice(3).filter(a => !usedAnchorIds.has(a.id));
                const needed = 3 - outfits.length;
                const backupBatch = backups.slice(0, needed).map(anchor =>
                  buildOutfitForAnchor(anchor, allProducts, store.name, prompts, selectedCollections, debug)
                    .then(o => (o?.anchor?.image && o?.anchor?.title && o?.items?.length >= 2) ? o : null)
                    .catch(() => null)
                );
                const backupResults = (await Promise.all(backupBatch)).filter(Boolean);
                outfits.push(...backupResults);
              }

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
            if (isDebug) completeData.debug = debug.getData();
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

    const outfit = await buildOutfitForAnchor(anchor, allProducts, store.name, prompts, null, debug);

    const completeData = {
      store: { name: store.name, domain },
      outfit,
      alternativeOutfits: [],
      productCount: allProducts.length,
      collectionCount: collections.length,
    };
    if (isDebug) completeData.debug = debug.getData();
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
