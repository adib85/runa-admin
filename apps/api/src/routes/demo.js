import express from "express";
import nodeFetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "@runa/config";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoClient } from "@runa/core/database/dynamodb";

const router = express.Router();

// ─── Prompt Defaults ─────────────────────────────────────────────────

const PROMPTS_KEY = "demo_prompts_config";

async function loadPrompts() {
  try {
    const docClient = dynamoClient.getDocClient();
    const result = await docClient.send(new GetCommand({
      TableName: config.dynamodb.tables.cache,
      Key: { id: PROMPTS_KEY },
    }));
    if (result.Item?.prompts) {
      return result.Item.prompts;
    }
  } catch (err) {
    console.error("Failed to load prompts:", err.message);
  }
  throw new Error("No prompts found in database. Please save prompts via /demo-prompts first.");
}

// ─── Prompts CRUD ────────────────────────────────────────────────────

router.get("/prompts", async (req, res) => {
  try {
    const prompts = await loadPrompts();
    res.json({ prompts });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
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

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Use node-fetch (not native fetch) — many Shopify stores behind Cloudflare
    // block Node's undici TLS fingerprint and return 429.
    const res = await nodeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json,text/html,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
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

let _modelOverride = null;

function getGeminiModel(useLite = true) {
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const model = _modelOverride || (useLite ? config.gemini.liteModel : config.gemini.model);
  return genAI.getGenerativeModel({ model });
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

function parseOutfitItems(rawItems, productMap, anchorId) {
  return (rawItems || [])
    .filter(id => productMap.has(id) && id !== anchorId)
    .map(id => {
      const p = productMap.get(id);
      return { id: p.id, title: p.title, handle: p.handle, price: p.price, image: p.image, vendor: p.vendor, collection: p.collection };
    });
}

function buildOutfitObj(anchor, items, outfitName) {
  const outfit = { anchor, items, outfit_name: outfitName };
  const total = [anchor, ...items].reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
  outfit.total_price = total.toFixed(2);
  return outfit;
}

const DEFAULT_BUILD_OUTFIT_CLOTHING_ONLY = `You are an expert fashion stylist creating a "Complete the Look" outfit for {{storeName}}.

**IMPORTANT:** This store's catalog does NOT include shoes, bags, or accessories. Build a clothing-only outfit using ONLY the available products below.

## INPUT

### Anchor Product
{{anchorProduct}}

### Available Collections
{{availableCollections}}

## TASK

Build a cohesive outfit around the anchor using 3 complementary CLOTHING items. Since no shoes/bags/accessories are available, focus on creating a complete, wearable look from clothing alone.

## COMPOSITION RULES BY ANCHOR TYPE

| Anchor Type | Complements |
|---|---|
| **Dress** | Outerwear/jacket + layering piece (cardigan, scarf-top, shrug) + contrasting bottom or second layer |
| **Top/Blouse** | Bottom (pants/skirt) + outerwear/jacket + second top for layering OR another bottom option |
| **Bottom (pants/skirt)** | Top + outerwear/jacket + second top or layering piece |
| **Outerwear** | Dress OR (top + bottom) + layering piece |
| **Knitwear** | Bottom + top for underneath OR dress + outerwear |

## HARD RULES
- Do NOT pick the anchor product itself.
- No duplicate categories (no two skirts, no two dresses, no two pants).
- Each item MUST be from a DIFFERENT collection than the anchor AND from each other.
- Each item must have an image.
- Season, occasion, color, and silhouette must be coherent.
- If anchor has a print, all complements must be SOLID.

## OUTPUT FORMAT

Return ONLY valid JSON, no markdown:
{
  "items": [<id1>, <id2>, <id3>],
  "outfit_name": "..."
}`;

const DEFAULT_CRITIC_CLOTHING_ONLY = `You are a senior fashion stylist auditing a clothing-only outfit. This store does NOT sell shoes, bags, or accessories — so their absence is NOT a flaw.

## INPUT

### Anchor Product
{{anchor}}

### Outfit Items
{{items}}

## CRITICAL VIOLATIONS (auto-fail)

1. **Duplicate category** — two skirts, two pants, two dresses, two tops of the same type.
2. **Same-type-as-anchor** — dress anchor + dress complement, top anchor + top complement.
3. **Layer logic violation** — top/blouse added with a dress anchor (dresses don't need a top underneath unless it's outerwear).
4. **Season mismatch** — heavy winter pieces mixed with summer pieces.
5. **Occasion mismatch** — evening cocktail dress paired with casual hoodie, or sportswear with formal blazer.
6. **Print + print** — anchor has a print AND a complement also has a print.
7. **Wrong gender** — mixing menswear and womenswear.

## MAJOR VIOLATIONS (deduct 2 points each)

1. **Silhouette clash** — oversized + oversized, no body line anywhere.
2. **Color overload** — more than 3 chromatic hues in one outfit.
3. **Heavy texture clash** — tweed + boucle, velvet + tweed in same outfit.
4. **Items don't form a wearable outfit** — e.g., 3 tops and no bottom, or pieces that can't physically be worn together.

## MINOR VIOLATIONS (deduct 1 point each)

1. **Color near-clash** — not forbidden but visually muddy.
2. **Generic feel** — outfit is compliant but uninspired.
3. **Redundant layering** — too many layers that don't add to the look.

## RULES THAT DO NOT APPLY (ignore completely)
- Missing shoes — this store has no shoes.
- Missing bag — this store has no bags.
- Missing accessories/jewelry — this store has no accessories.

## SCORING

Start at 10. Apply deductions. Approved if score >= 7.

Return ONLY valid JSON, no markdown:
{
  "approved": true,
  "score": 8,
  "issues": [{"severity": "minor", "rule": "...", "description": "..."}],
  "fix_instruction": null
}`;

async function buildOutfitForAnchor(anchor, allProducts, storeName, prompts, selectedCollections, debug) {
  const model = getGeminiModel(true);
  const productMap = new Map(allProducts.map(p => [p.id, p]));

  const complementary = allProducts.filter(p =>
    p.id !== anchor.id &&
    p.collection !== anchor.collection
  );
  const compGrouped = groupByCollection(complementary, selectedCollections);

  const anchorJson = JSON.stringify({ id: anchor.id, title: anchor.title, type: anchor.type, price: anchor.price, collection: anchor.collection });

  const basePrompt = prompts.buildOutfit
    .replace("{{storeName}}", storeName)
    .replace("{{anchorProduct}}", anchorJson)
    .replace("{{availableCollections}}", formatGrouped(compGrouped));

  let anchorImageParts = [];
  if (anchor.image) {
    const img = await fetchImageAsBase64(anchor.image);
    if (img) {
      anchorImageParts = [
        { inlineData: { mimeType: img.contentType, data: img.base64 } },
        `(Image of anchor: "${anchor.title}")`,
      ];
    }
  }

  // --- Attempt 1: Standard build ---
  const t1 = Date.now();
  const result1 = await model.generateContent([basePrompt, ...anchorImageParts]);
  const u1 = result1.response.usageMetadata;
  debug.track(`buildOutfit "${anchor.title}"`, { inputTokens: u1?.promptTokenCount, outputTokens: u1?.candidatesTokenCount, inputChars: basePrompt.length, rawResponse: result1.response.text(), elapsed: Date.now() - t1 });
  const data1 = JSON.parse(result1.response.text().replace(/```json\n?|\n?```/g, "").trim());
  let currentOutfit = buildOutfitObj(anchor, parseOutfitItems(data1.items, productMap, anchor.id), data1.outfit_name);

  // --- Critic 1 ---
  const review1 = await criticOutfit(currentOutfit, prompts, debug);
  if (review1.approved) return currentOutfit;

  // --- Attempt 2: Rebuild with critic feedback ---
  const formatIssues = (review) => (review.issues || []).map(i =>
    typeof i === 'string' ? `- ${i}` : `- [${i.severity}] ${i.rule}: ${i.description}`
  ).join("\n");

  const rebuildPrompt = basePrompt + `

IMPORTANT — PREVIOUS ATTEMPT WAS REJECTED BY THE CRITIC (Score: ${review1.score}/10):
Issues found:
${formatIssues(review1)}
${review1.fix_instruction ? `\nFIX INSTRUCTION: ${review1.fix_instruction}` : ''}

You MUST fix these issues. Follow the fix instruction exactly. Pick DIFFERENT items that resolve the problems above. Do NOT repeat the same mistakes.`;

  let lastReview = review1;
  let bestOutfit = currentOutfit;
  let bestScore = review1.score || 0;

  try {
    const t2 = Date.now();
    const result2 = await model.generateContent([rebuildPrompt, ...anchorImageParts]);
    const u2 = result2.response.usageMetadata;
    const text2 = result2.response.text().replace(/```json\n?|\n?```/g, "").trim();
    debug.track(`rebuild "${anchor.title}"`, { inputTokens: u2?.promptTokenCount, outputTokens: u2?.candidatesTokenCount, inputChars: rebuildPrompt.length, rawResponse: text2, elapsed: Date.now() - t2 });

    const data2 = JSON.parse(text2);
    const items2 = parseOutfitItems(data2.items, productMap, anchor.id);
    if (items2.length >= 2) {
      currentOutfit = buildOutfitObj(anchor, items2, data2.outfit_name || currentOutfit.outfit_name);

      // --- Critic 2 ---
      lastReview = await criticOutfit(currentOutfit, prompts, debug);
      if (lastReview.approved) return currentOutfit;
      if ((lastReview.score || 0) > bestScore) {
        bestOutfit = currentOutfit;
        bestScore = lastReview.score || 0;
      }
      console.log(`[Critic] "${anchor.title}": rebuild also rejected (score ${lastReview.score}/10)`);
    }
  } catch (err) {
    console.error(`[Critic] Rebuild parse failed for "${anchor.title}":`, err.message);
  }

  // --- Attempt 3: Detect catalog type and use appropriate fallback ---
  const collectionNames = Object.keys(compGrouped).join(" ").toLowerCase();
  const hasAccessories = /shoe|boot|sneaker|sandal|heel|pump|flat|bag|purse|clutch|jewel|earring|necklace|bracelet|accessor/i.test(collectionNames);

  if (hasAccessories) {
    // Full store: do a second standard rebuild with combined feedback from both critics
    const combinedIssues = [...(review1.issues || []), ...(lastReview.issues || [])];
    const combinedList = combinedIssues.map(i =>
      typeof i === 'string' ? `- ${i}` : `- [${i.severity}] ${i.rule}: ${i.description}`
    ).join("\n");

    const rebuild2Prompt = basePrompt + `

IMPORTANT — TWO PREVIOUS ATTEMPTS WERE BOTH REJECTED BY THE CRITIC.
Combined issues from both attempts:
${combinedList}

You have FAILED TWICE. This is your LAST CHANCE. You MUST:
1. Pick items from DIFFERENT categories (one shoe, one bag, one accessory/jewelry — NO duplicates).
2. Match the occasion and season of the anchor exactly.
3. Ensure color harmony — stick to neutrals if unsure.
4. Pick COMPLETELY DIFFERENT items from your previous attempts.`;

    try {
      const t3 = Date.now();
      const result3 = await model.generateContent([rebuild2Prompt, ...anchorImageParts]);
      const u3 = result3.response.usageMetadata;
      const text3 = result3.response.text().replace(/```json\n?|\n?```/g, "").trim();
      debug.track(`rebuild2 "${anchor.title}"`, { inputTokens: u3?.promptTokenCount, outputTokens: u3?.candidatesTokenCount, inputChars: rebuild2Prompt.length, rawResponse: text3, elapsed: Date.now() - t3 });

      const data3 = JSON.parse(text3);
      const items3 = parseOutfitItems(data3.items, productMap, anchor.id);
      if (items3.length >= 2) {
        currentOutfit = buildOutfitObj(anchor, items3, data3.outfit_name || currentOutfit.outfit_name);

        const review3 = await criticOutfit(currentOutfit, prompts, debug);
        if (review3.approved) return currentOutfit;
        if ((review3.score || 0) > bestScore) {
          bestOutfit = currentOutfit;
          bestScore = review3.score || 0;
        }
        console.log(`[Critic] "${anchor.title}": second rebuild also rejected (score ${review3.score}/10)`);
      }
    } catch (err) {
      console.error(`[Critic] Second rebuild failed for "${anchor.title}":`, err.message);
    }
  } else {
    // Clothing-only store: use the clothing-only builder + critic
    const clothingOnlyTemplate = prompts.buildOutfitClothingOnly || DEFAULT_BUILD_OUTFIT_CLOTHING_ONLY;
    const fallbackPrompt = clothingOnlyTemplate
      .replace("{{storeName}}", storeName)
      .replace("{{anchorProduct}}", anchorJson)
      .replace("{{availableCollections}}", formatGrouped(compGrouped));

    try {
      const t3 = Date.now();
      const result3 = await model.generateContent([fallbackPrompt, ...anchorImageParts]);
      const u3 = result3.response.usageMetadata;
      const text3 = result3.response.text().replace(/```json\n?|\n?```/g, "").trim();
      debug.track(`clothingOnly "${anchor.title}"`, { inputTokens: u3?.promptTokenCount, outputTokens: u3?.candidatesTokenCount, inputChars: fallbackPrompt.length, rawResponse: text3, elapsed: Date.now() - t3 });

      const data3 = JSON.parse(text3);
      const items3 = parseOutfitItems(data3.items, productMap, anchor.id);
      if (items3.length >= 2) {
        currentOutfit = buildOutfitObj(anchor, items3, data3.outfit_name || currentOutfit.outfit_name);

        const review3 = await criticClothingOnlyOutfit(currentOutfit, prompts, debug);
        if (review3.approved) return currentOutfit;
        if ((review3.score || 0) > bestScore) {
          bestOutfit = currentOutfit;
          bestScore = review3.score || 0;
        }
        console.log(`[Critic] "${anchor.title}": clothing-only fallback also rejected (score ${review3.score}/10)`);
      }
    } catch (err) {
      console.error(`[Critic] Clothing-only fallback failed for "${anchor.title}":`, err.message);
    }
  }

  // No attempt was approved — return the best one we got if it has at least 2 items
  // AND a score of at least 3. Below 3 means the critic found multiple critical violations
  // (e.g. 3 of same category, missing shoes when shoes exist) — those outfits look obviously
  // broken and would damage demo credibility.
  if (bestOutfit?.items?.length >= 2 && bestScore >= 3) {
    console.log(`[Demo] "${anchor.title}": all attempts rejected, using best (score ${bestScore}/10)`);
    return bestOutfit;
  }

  console.log(`[Demo] "${anchor.title}": all outfit attempts failed (best score ${bestScore}/10), returning null`);
  return null;
}

async function criticOutfit(outfit, prompts, debug) {
  if (!outfit.anchor || !outfit.items?.length) return { approved: true, score: 10, issues: [] };

  try {
    const critic = getGeminiModel(true);
    const anchorDesc = `"${outfit.anchor.title}" (${outfit.anchor.collection})`;
    const itemDescs = outfit.items.map((item, i) =>
      `${i}: "${item.title}" (${item.collection})`
    ).join("\n");

    const criticTemplate = prompts.criticOutfit || `You are a fashion critic reviewing an outfit for a product demo. Look at ALL the product images and be strict but fair.

ANCHOR: {{anchor}}
ITEMS:
{{items}}

VISUAL + TEXT CHECKLIST:
1. Does this look like a cohesive outfit a real stylist would recommend? (check colors, textures, proportions in the images)
2. Same seasonal world? (no fur/heavy textures + sandals/summer items — check visually)
3. Same occasion? (no casual jacket with cocktail dress — check visual formality)
4. Silhouette balanced? (no oversized + oversized)
5. All different categories? (no two shoes, no two bags)
6. If anchor is a dress, are there NO tops/bottoms in the complements?
7. Color harmony? (do the actual product colors work together visually?)
8. Does the outfit include shoes?
9. Does the outfit include a bag (or jewelry if no bags available)?

Rate the outfit 1-10. If score < 7, flag issues.

Return ONLY valid JSON:
{
  "score": 8,
  "approved": true/false,
  "issues": ["issue 1", "issue 2"],
  "remove_indexes": [0, 2]
}

"approved": true if score >= 7. "remove_indexes": indexes of items to remove. Empty [] if approved.`;

    const criticText = criticTemplate
      .replace("{{storeName}}", outfit.anchor.vendor || "the store")
      .replace("{{anchor}}", anchorDesc)
      .replace("{{items}}", itemDescs);

    // Fetch all outfit images in parallel
    const allItems = [{ ...outfit.anchor, label: "ANCHOR" }, ...outfit.items.map((item, i) => ({ ...item, label: `ITEM ${i}` }))];
    const imagePromises = allItems
      .filter(p => p.image)
      .map(async (p) => {
        const img = await fetchImageAsBase64(p.image);
        return img ? { ...img, label: p.label, title: p.title } : null;
      });
    const images = (await Promise.all(imagePromises)).filter(Boolean);

    const parts = [];
    for (const img of images) {
      parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
      parts.push(`(${img.label}: "${img.title}")`);
    }
    parts.push(criticText);

    const t = Date.now();
    const result = await critic.generateContent(parts);
    const u = result.response.usageMetadata;
    const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
    debug.track(`critic "${outfit.anchor.title}"`, { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, inputChars: criticText.length, rawResponse: text, elapsed: Date.now() - t });

    const review = JSON.parse(text);
    console.log(`[Critic] "${outfit.anchor.title}": score ${review.score}/10, approved: ${review.approved}${review.issues?.length ? ', issues: ' + review.issues.join(', ') : ''}`);
    return review;
  } catch (err) {
    console.error("Critic failed (non-blocking):", err.message);
    return { approved: true, score: 0, issues: [] };
  }
}

async function criticClothingOnlyOutfit(outfit, prompts, debug) {
  if (!outfit.anchor || !outfit.items?.length) return { approved: true, score: 10, issues: [] };

  try {
    const critic = getGeminiModel(true);
    const anchorDesc = `"${outfit.anchor.title}" (${outfit.anchor.collection})`;
    const itemDescs = outfit.items.map((item, i) =>
      `${i}: "${item.title}" (${item.collection})`
    ).join("\n");

    const template = prompts.criticClothingOnly || DEFAULT_CRITIC_CLOTHING_ONLY;
    const criticText = template
      .replace("{{storeName}}", outfit.anchor.vendor || "the store")
      .replace("{{anchor}}", anchorDesc)
      .replace("{{items}}", itemDescs);

    const allItems = [{ ...outfit.anchor, label: "ANCHOR" }, ...outfit.items.map((item, i) => ({ ...item, label: `ITEM ${i}` }))];
    const imagePromises = allItems
      .filter(p => p.image)
      .map(async (p) => {
        const img = await fetchImageAsBase64(p.image);
        return img ? { ...img, label: p.label, title: p.title } : null;
      });
    const images = (await Promise.all(imagePromises)).filter(Boolean);

    const parts = [];
    for (const img of images) {
      parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
      parts.push(`(${img.label}: "${img.title}")`);
    }
    parts.push(criticText);

    const t = Date.now();
    const result = await critic.generateContent(parts);
    const u = result.response.usageMetadata;
    const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
    debug.track(`criticClothingOnly "${outfit.anchor.title}"`, { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, inputChars: criticText.length, rawResponse: text, elapsed: Date.now() - t });

    const review = JSON.parse(text);
    console.log(`[CriticClothingOnly] "${outfit.anchor.title}": score ${review.score}/10, approved: ${review.approved}${review.issues?.length ? ', issues: ' + review.issues.map(i => typeof i === 'string' ? i : i.description).join(', ') : ''}`);
    return review;
  } catch (err) {
    console.error("Clothing-only critic failed (non-blocking):", err.message);
    return { approved: true, score: 0, issues: [] };
  }
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

async function getGeoFromIp(ip) {
  if (!ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1") return null;
  try {
    const cleanIp = ip.replace(/^::ffff:/, "");
    const res = await fetchWithTimeout(`http://ip-api.com/json/${cleanIp}?fields=country,city`, 3000);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === "fail") return null;
    return { country: data.country, city: data.city };
  } catch {
    return null;
  }
}

async function logDemoSearch(domain, storeName, fromCache, ip) {
  try {
    const geo = await getGeoFromIp(ip);
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
      ...(geo && { country: geo.country, city: geo.city }),
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
  const clientIp = req.headers["x-real-ip"] || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;

  // Allow model override via URL: ?model=lite or ?model=flash or ?model=gemini-3-flash-preview
  const modelMap = { lite: config.gemini.liteModel, flash: config.gemini.model };
  _modelOverride = modelMap[req.query.model] || req.query.model || null;

  try {
    // Step 0: Validate
    sendSSE(res, "status", { step: "validate", message: `Connecting to ${domain}...` });
    const store = await validateShopifyStore(domain);
    if (!store) {
      sendSSE(res, "error", {
        message: "This doesn't appear to be a Shopify store. This demo currently works with Shopify stores only. For other platforms (WooCommerce, VTEX, Magento), contact us at adrian@askruna.ai",
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
            logDemoSearch(domain, store.name, true, clientIp).catch(() => {});
          } else {
            // Gemini #2: Select 3 anchors from different categories
            const anchors = await selectAnchors(allProducts, selectedCollections, store.name, prompts, debug);

            if (anchors.length === 0) {
              useCollectionApproach = false;
            } else {
              // Build 3 outfits in parallel
              const outfitPromises = anchors.slice(0, 3).map(anchor =>
                buildOutfitForAnchor(anchor, allProducts, store.name, prompts, selectedCollections, debug)
                  .then(o => (o?.anchor?.image && o?.anchor?.title && o?.items?.length >= 2) ? o : null)
                  .catch(err => {
                    console.error(`[Demo] Outfit build failed for ${anchor.title}:`, err.message);
                    return null;
                  })
              );
              const outfits = (await Promise.all(outfitPromises)).filter(Boolean);

              if (outfits.length === 0) {
                sendSSE(res, "error", {
                  message: "We couldn't generate a quality outfit for this store. The catalog may lack the product variety needed for styling. Contact us at adrian@askruna.ai for help.",
                });
                return res.end();
              } else {
                completeData = {
                  store: { name: store.name, domain },
                  outfit: outfits[0],
                  alternativeOutfits: outfits.slice(1),
                  productCount: totalProducts,
                  collectionCount: validHandles.length,
                };
                saveDemoResult(domain, store.name, completeData).catch(() => {});
                logDemoSearch(domain, store.name, false, clientIp).catch(() => {});
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

    if (!outfit || !outfit.items?.length) {
      sendSSE(res, "error", {
        message: "We couldn't generate a quality outfit for this store. The catalog may lack the product variety needed for styling. Contact us at adrian@askruna.ai for help.",
      });
      return res.end();
    }

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
    logDemoSearch(domain, store.name, false, clientIp).catch(() => {});
    res.end();
  } catch (err) {
    console.error("Demo analyze error:", err);
    sendSSE(res, "error", { message: "Something went wrong. Please try again." });
    res.end();
  }
});

export default router;
