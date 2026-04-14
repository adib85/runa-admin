import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "@runa/config";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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
1. Pick 2-3 MAIN collection candidates — product category collections containing "hero" items like dresses, tops, shirts, jackets, knitwear, or coats.
2. Pick 4-5 COMPLEMENTARY collection candidates — product category collections containing items that complete an outfit: shoes/boots/sandals/sneakers, pants/trousers/jeans, bags/shoulder bags, accessories, jewelry, scarves, belts, etc.
3. Rank them by priority (best first).

Return ONLY valid JSON, no markdown:
{
  "main": [{"handle": "...", "title": "...", "reason": "..."}],
  "complementary": [{"handle": "...", "title": "...", "reason": "..."}]
}`,

  buildOutfit: `You are an expert fashion stylist creating a "Complete the Look" outfit for {{storeName}}.

CRITICAL: You MUST ONLY use products that exist in the data below. Copy the exact id, title, handle, price, and image from the data. NEVER invent or fabricate products, prices, or image URLs.

===== MAIN COLLECTIONS (pick the ANCHOR product from one of these) =====
{{mainCollections}}

===== COMPLEMENTARY COLLECTIONS (pick 3-5 items from these to complete the look) =====
{{complementaryCollections}}

Your task:
1. ANCHOR SELECTION: Pick the BEST anchor product from one of the main collections. Choose something:
   - Visually striking and photogenic (it will be the hero image)
   - Mid-to-high price range (shows value)
   - Versatile enough to pair with items from the complementary collections
   - NOT a basic/plain item (no plain white tees, no generic socks)
   - Has an image (image field is not null)

2. OUTFIT BUILDING: Pick 3-5 items from the complementary collections that create a cohesive outfit with the anchor:
   - Pick from DIFFERENT collections (e.g. one from Shoes, one from Bags, one from Jewellery)
   - Consider color coordination and style coherence across all pieces
   - Consider occasion matching (don't mix formal shoes with beach shorts)
   - Each item must have an image (image field is not null)

3. Give the outfit a short name.

Return ONLY valid JSON, no markdown:
{
  "anchor": {
    "id": <number>,
    "title": "...",
    "handle": "...",
    "price": "...",
    "image": "...",
    "collection": "..."
  },
  "items": [
    {
      "id": <number>,
      "title": "...",
      "handle": "...",
      "price": "...",
      "image": "...",
      "collection": "...",
      "role": "bottom|shoes|bag|accessory|outerwear|jewelry"
    }
  ],
  "outfit_name": "...",
  "total_price": "sum of all items including anchor"
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

function groupByCollection(products, selectedCollections) {
  const handleToTitle = {};
  [...(selectedCollections?.main || []), ...(selectedCollections?.complementary || [])]
    .forEach(c => { handleToTitle[c.handle] = c.title; });

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
      tags: p.tags.slice(0, 5),
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

async function buildOutfit(mainProducts, complementaryProducts, storeName, prompts, selectedCollections) {
  const model = getGeminiModel(true);

  const mainGrouped = groupByCollection(mainProducts, selectedCollections);
  const compGrouped = groupByCollection(complementaryProducts, selectedCollections);

  const prompt = prompts.buildOutfit
    .replace("{{storeName}}", storeName)
    .replace("{{mainCollections}}", formatGrouped(mainGrouped))
    .replace("{{complementaryCollections}}", formatGrouped(compGrouped));

  const result = await model.generateContent(prompt);
  const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
  const outfit = JSON.parse(text);

  // Validate products exist in actual data
  const allProducts = [...mainProducts, ...complementaryProducts];
  const productMap = new Map(allProducts.map(p => [p.id, p]));

  if (outfit.anchor?.id && productMap.has(outfit.anchor.id)) {
    const real = productMap.get(outfit.anchor.id);
    outfit.anchor = { ...outfit.anchor, title: real.title, handle: real.handle, price: real.price, image: real.image, vendor: real.vendor };
  }

  if (outfit.items) {
    outfit.items = outfit.items
      .filter(item => productMap.has(item.id))
      .map(item => {
        const real = productMap.get(item.id);
        return { ...item, title: real.title, handle: real.handle, price: real.price, image: real.image, vendor: real.vendor };
      });
  }

  // Validate outfit coherence
  const validatedOutfit = await validateOutfit(outfit, mainGrouped, compGrouped, prompts, storeName);

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

    const valResult = await validator.generateContent(
      `You are a fashion expert reviewing an outfit for style coherence.

Anchor product: ${anchorDesc}
Complementary items:
${itemDescs}

Which items DO NOT match the anchor? Consider:
- Occasion mismatch (ski boots with cocktail dress, flip-flops with blazer, etc.)
- Season mismatch (winter coat with summer sandals)
- Style clash (sportswear with formal evening wear)
- Gender mismatch

Return ONLY a JSON array of the INDEX numbers (0-based) of items to REMOVE. If all items are fine, return [].
Example: [1, 3] means remove items at index 1 and 3.
Return ONLY the JSON array, nothing else.`
    );
    const valText = valResult.response.text().replace(/```json\n?|\n?```/g, "").trim();
    const removeIndexes = JSON.parse(valText);

    if (!Array.isArray(removeIndexes) || removeIndexes.length === 0) return outfit;

    const removedItems = removeIndexes.map(i => outfit.items[i]?.title).filter(Boolean);
    const removeSet = new Set(removeIndexes);
    outfit.items = outfit.items.filter((_, i) => !removeSet.has(i));

    // If too many items removed, retry outfit generation with feedback
    if (outfit.items.length < 2) {
      console.log(`[Demo] Outfit validation removed ${removedItems.length} items, retrying with feedback...`);
      const model = getGeminiModel(true);
      const retryPrompt = prompts.buildOutfit
        .replace("{{storeName}}", storeName)
        .replace("{{mainCollections}}", formatGrouped(mainGrouped))
        .replace("{{complementaryCollections}}", formatGrouped(compGrouped));

      const feedbackPrompt = `${retryPrompt}

IMPORTANT: A previous attempt produced a bad outfit. These items were REJECTED for not matching the anchor:
${removedItems.map(t => `- "${t}" — style/occasion mismatch`).join("\n")}

Do NOT pick similar items. Choose items that truly match the anchor's style, occasion, and season.`;

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

      // Validate retry outfit coherence (no further retries to avoid loops)
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
    }

    return outfit;
  } catch (err) {
    console.error("Outfit validation failed (non-blocking):", err.message);
    return outfit;
  }
}

// ─── DynamoDB Cache ──────────────────────────────────────────────────

const DEMO_STORE_ID = "demo_searches";

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

async function logDemoSearch(domain, storeName, fromCache) {
  try {
    const docClient = dynamoClient.getDocClient();
    await docClient.send(new PutCommand({
      TableName: config.dynamodb.tables.cache,
      Item: {
        id: `demo_log_${domain}_${Date.now()}`,
        storeId: DEMO_STORE_ID,
        domain,
        storeName,
        fromCache,
        searchedAt: Date.now(),
        type: "demo_search",
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
      .filter(r => !r.type && r.result)
      .forEach(r => {
        outfitsByDomain[r.domain] = r.result?.outfit;
      });

    const searches = results
      .filter(r => r.type === "demo_search")
      .sort((a, b) => (b.searchedAt || 0) - (a.searchedAt || 0));

    res.json({
      cached: Object.keys(outfitsByDomain).length,
      totalSearches: searches.length,
      outfitsByDomain,
      recentSearches: searches.slice(0, 100),
    });
  } catch (err) {
    console.error("List demo searches error:", err);
    res.status(500).json({ error: "Failed to fetch demo searches" });
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

      // Step 2: Gemini #1 — Select collections
      sendSSE(res, "status", { step: "classify", message: "Analyzing collections..." });
      let selectedCollections;
      try {
        selectedCollections = await selectCollections(collections, prompts);
      } catch (err) {
        console.error("Gemini collection selection failed:", err.message);
        useCollectionApproach = false;
      }

      if (useCollectionApproach) {
        const mainHandles = selectedCollections.main.map(c => c.handle);
        const compHandles = selectedCollections.complementary.map(c => c.handle);
        const allHandles = [...mainHandles, ...compHandles];

        sendSSE(res, "status", {
          step: "classify",
          message: `Selected ${allHandles.length} collections for styling`,
          collections: selectedCollections,
        });

        // Step 3: Fetch products from selected collections in parallel
        sendSSE(res, "status", { step: "products", message: "Loading products..." });

        const productResults = await Promise.all(
          allHandles.map(handle => fetchCollectionProducts(domain, handle, 30))
        );

        // Map products to main vs complementary, drop empty collections
        let mainProducts = [];
        let complementaryProducts = [];
        const validMain = [];
        const validComp = [];

        mainHandles.forEach((handle, i) => {
          const products = productResults[i];
          if (products.length >= 3) {
            mainProducts.push(...products);
            validMain.push(handle);
          }
        });

        compHandles.forEach((handle, i) => {
          const idx = mainHandles.length + i;
          const products = productResults[idx];
          if (products.length >= 3) {
            complementaryProducts.push(...products);
            validComp.push(handle);
          }
        });

        // Fallback if not enough valid collections
        if (validMain.length === 0 || validComp.length < 2) {
          useCollectionApproach = false;
        } else {
          const totalProducts = mainProducts.length + complementaryProducts.length;
          sendSSE(res, "status", {
            step: "products",
            message: `Found ${totalProducts} products across ${validMain.length + validComp.length} collections`,
            productCount: totalProducts,
          });

          // Step 4: Gemini #2 — Build outfit
          sendSSE(res, "status", { step: "style", message: "Styling your outfit..." });
          const outfit = await buildOutfit(mainProducts, complementaryProducts, store.name, prompts, selectedCollections);

          const completeData = {
            store: { name: store.name, domain },
            outfit,
            productCount: totalProducts,
            collectionCount: validMain.length + validComp.length,
          };
          sendSSE(res, "complete", completeData);
          saveDemoResult(domain, store.name, completeData).catch(() => {});
          logDemoSearch(domain, store.name, false).catch(() => {});
          return res.end();
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

    // Split products into rough categories for the outfit call
    sendSSE(res, "status", { step: "style", message: "Styling your outfit..." });

    // Use all products as both main and complementary candidates
    const outfit = await buildOutfit(allProducts, allProducts, store.name, prompts, null);

    const completeData = {
      store: { name: store.name, domain },
      outfit,
      productCount: allProducts.length,
      collectionCount: collections.length,
    };
    sendSSE(res, "complete", completeData);
    saveDemoResult(domain, store.name, completeData).catch(() => {});
    logDemoSearch(domain, store.name, false).catch(() => {});
    res.end();
  } catch (err) {
    console.error("Demo analyze error:", err);
    sendSSE(res, "error", { message: "Something went wrong. Please try again." });
    res.end();
  }
});

export default router;
