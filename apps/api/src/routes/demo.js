import express from "express";
import nodeFetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "@runa/config";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoClient } from "@runa/core/database/dynamodb";
import { seedDemoCache } from "../services/demoSeed.js";

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

// Single-attempt fetch with abort timeout. Used by retry wrapper below.
async function fetchOnce(url, timeoutMs) {
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

// Phase 8: retries with exponential backoff for transient Shopify failures.
// Triggers a retry on:
//   - Network errors (fetch throws)
//   - HTTP 429 (rate limit) — common when running 5+ parallel analyzes
//   - HTTP 5xx (server error)
//   - Empty body (rare but happens under Cloudflare load)
//
// Backoff: 250ms, 750ms, 2000ms (capped at 3 attempts total). Total worst-case
// added latency ≈ 3s per failing endpoint, but only when needed — happy path
// is unchanged.
async function fetchWithTimeout(url, timeoutMs = 10000, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = 250 * Math.pow(3, attempt - 1); // 250, 750, 2250
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const res = await fetchOnce(url, timeoutMs);
      // Retry on transient HTTP failures
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} on ${url}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`fetch failed after ${maxAttempts} attempts: ${url}`);
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
    return data?.name
      ? { name: data.name, domain, currency: data.currency || "USD" }
      : null;
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

function getGeminiModel(useLite = false) {
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const model = _modelOverride || (useLite ? config.gemini.liteModel : config.gemini.model);
  // Cap thinking on the heavier Flash model. Lite keeps its default (effectively no thinking).
  const isLite = /lite/i.test(model);
  const modelOptions = { model };
  if (!isLite) {
    modelOptions.generationConfig = { thinkingConfig: { thinkingBudget: 1000 } };
  }
  return genAI.getGenerativeModel(modelOptions);
}

async function selectCollections(collections, prompts, debug) {
  const model = getGeminiModel();
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

// Default triptych prompt used if `prompts.pickAnchorTriptych` is not configured in DB.
const DEFAULT_TRIPTYCH_PROMPT = `You are picking 3 anchors for a "Complete the Look" demo for {{storeName}} (catalog archetype: {{archetype}}).

The product images and metadata for shortlisted candidates are attached below. Pick the 3 anchors that form the strongest visual TRIPTYCH for a first-impression demo:

- SLOT 1 — THE WOW: most visually striking, "stop-the-scroll" piece. Best image quality. Editorial / model photography preferred over flat-lay. Statement silhouette or hero color.
- SLOT 2 — THE RANGE SIGNAL: clearly DIFFERENT category AND DIFFERENT dominant color from Slot 1. Proves the system styles more than one type of piece.
- SLOT 3 — THE EVERYDAY HERO: aspirational but wearable. Different mood from the above two (e.g., daywear if 1+2 are bridal/evening).

CRITICAL DIVERSITY RULES:
- No two anchors in the same dominant color (visually).
- No two anchors in the same category sub-style (e.g. two bridal lehengas = REJECTED).
- No two anchors in the same mood (e.g. two evening pieces = REJECTED).
- The 3 anchors together should feel like 3 different OUTFIT UNIVERSES.

Return ONLY JSON, no markdown:
{"anchors": [<id_slot1>, <id_slot2>, <id_slot3>]}`;

async function selectAnchors(allProducts, selectedCollections, storeName, prompts, catalogProfile, debug) {
  const model = getGeminiModel();
  const productMap = new Map(allProducts.map(p => [p.id, p]));

  // ── Stage A: text shortlist (cheap) ─────────────────────────────
  // We reuse the existing selectAnchors prompt but ask Gemini for up to 8
  // candidates instead of the production "3". The prompt's instruction can
  // stay as-is — Gemini will return whatever the output schema permits;
  // we just shortlist by taking the first 8 and dedup'ing.
  const grouped = groupByCollection(allProducts, selectedCollections);
  const shortlistPrompt = (prompts.shortlistAnchors || prompts.selectAnchors)
    .replace("{{storeName}}", storeName)
    .replace("{{allCollections}}", formatGrouped(grouped));

  const tA = Date.now();
  const resultA = await model.generateContent(shortlistPrompt);
  const uA = resultA.response.usageMetadata;
  debug.track("anchorShortlist", { inputTokens: uA?.promptTokenCount, outputTokens: uA?.candidatesTokenCount, inputChars: shortlistPrompt.length, rawResponse: resultA.response.text(), elapsed: Date.now() - tA });
  let parsedA;
  try {
    parsedA = JSON.parse(resultA.response.text().replace(/```json\n?|\n?```/g, "").trim());
  } catch (err) {
    debug.track("anchorShortlist parse failed", { error: err.message });
    return [];
  }

  // Defensive lookup — handles Gemini returning IDs as strings or rounded numbers.
  const lookupProduct = (id) => {
    if (productMap.has(id)) return productMap.get(id);
    if (productMap.has(String(id))) return productMap.get(String(id));
    const n = Number(id);
    if (Number.isFinite(n) && productMap.has(n)) return productMap.get(n);
    return null;
  };
  const shortlistProducts = (parsedA.anchors || []).map(lookupProduct).filter(Boolean);
  const seen = new Set();
  const shortlist = shortlistProducts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id); return true;
  }).slice(0, 8);

  // If the shortlist already has ≤3 candidates, skip Stage B (no triptych choice to make).
  if (shortlist.length <= 3) {
    debug.track("anchorTriptych skipped", { reason: `shortlist=${shortlist.length}, no triptych pick needed` });
    return shortlist;
  }

  // ── Stage B: multimodal triptych pick ───────────────────────────
  const triptychPrompt = (prompts.pickAnchorTriptych || DEFAULT_TRIPTYCH_PROMPT)
    .replace("{{storeName}}", storeName)
    .replace("{{archetype}}", catalogProfile?.archetype || "unknown");

  // Fetch candidate images in parallel.
  const candidateData = await Promise.all(
    shortlist.map(async (p) => ({
      product: p,
      image: p.image ? await fetchImageAsBase64(p.image) : null,
    }))
  );

  const parts = [triptychPrompt];
  for (const { product, image } of candidateData) {
    if (image) {
      parts.push({ inlineData: { mimeType: image.contentType, data: image.base64 } });
    }
    parts.push(`Candidate id=${product.id}: "${product.title}" — collection: ${product.collection}, price: ${product.price}`);
  }

  const tB = Date.now();
  const resultB = await model.generateContent(parts);
  const uB = resultB.response.usageMetadata;
  const textB = resultB.response.text().replace(/```json\n?|\n?```/g, "").trim();
  debug.track("anchorTriptych", { inputTokens: uB?.promptTokenCount, outputTokens: uB?.candidatesTokenCount, candidates: shortlist.length, rawResponse: textB, elapsed: Date.now() - tB });

  let parsedB;
  try {
    parsedB = JSON.parse(textB);
  } catch (err) {
    // If Stage B fails to parse, fall back to Stage A's first 3.
    debug.track("anchorTriptych fallback", { reason: err.message });
    return shortlist.slice(0, 3);
  }

  const tripProducts = (parsedB.anchors || []).map(lookupProduct).filter(Boolean);
  const seen2 = new Set();
  const triptych = tripProducts.filter(p => {
    if (seen2.has(p.id)) return false;
    seen2.add(p.id); return true;
  }).slice(0, 3);
  // Final safety net — if triptych picker returned <3 valid IDs, top up from shortlist.
  if (triptych.length < 3) {
    for (const p of shortlist) {
      if (triptych.length >= 3) break;
      if (!triptych.find(t => t.id === p.id)) triptych.push(p);
    }
  }
  return triptych;
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

// ─── Catalog Profile (Phase 1 — Level 1 critic preamble) ────────────
//
// Detects which product categories actually exist in the analyzed catalog
// so downstream prompts (builder + critic) don't apply rules that are
// physically impossible to satisfy (e.g. "Missing shoes" on a saree-only
// store). Mirrors the manual catalog preamble that took the WeaverStory
// outfit from 3/10 to 8/10 in the curation work.

// Multilingual category detection (EN + DE + FR + IT + ES + NL + PT).
// Catalogs from European stores routinely mix the local language with
// English — e.g. thesmartdresser.de has both "TSD - Schuhe" (DE for shoes)
// and "LA Trainer OG" (EN). Without German keywords, the catalog scan
// reports shoes: false and the critic auto-fails outfits with "Missing shoes".
const CATEGORY_PATTERNS = {
  // Note: trailing `(?:e|en|er|n|s)?` covers English (-s), German (-e/-en/-er/-n) and Italian/Spanish plural suffixes.
  shoes:     /\b(shoe|sandal|boot|bootie|sneaker|trainer|heel|pump|flat|slipper|loafer|mule|espadrille|footwear|mojari|kolhapuri|jutti|schuh|halbschuh|turnschuh|stiefel|chaussure|scarpa|stivale|zapato|zapatilla|bota|sapato|tenis|schoen|laars)(?:e|en|er|n|s)?\b/i,
  bags:      /\b(bag|clutch|tote|purse|handbag|crossbody|backpack|wallet|potli|pouch|tasche|rucksack|geldbeutel|sac|sacoche|bourse|borsa|borse|borsetta|zaino|bolso|bolsa|mochila|cartera|tas)(?:e|en|er|n|s)?\b/i,
  jewelry:   /\b(jewel(?:lery|ry)|earring|necklace|bangle|ring|bracelet|pendant|choker|chandbali|jhumka|polki|kundan|hasli|maang|tikka|schmuck|ohrring|halskette|armband|bijou|collier|boucle|gioiell|orecchin|collana|bracciale|joya|pendiente|collar|pulsera|anillo|sieraad)(?:e|en|er|n|s)?\b/i,
  outerwear: /\b(coat|jacket|blazer|cape|trench|parka|puffer|cardigan|outerwear|jacke|mantel|jacken|veste|manteau|giacca|giacche|cappotto|piumino|chaqueta|abrigo|gabardina|casaco|jas)(?:e|en|er|n|s)?\b/i,
  bottoms:   /\b(pant|trouser|jean|denim|skirt|short|legging|palazzo|culotte|bottom|hose|hosen|rock|jupe|pantalon|gonna|gonne|pantalone|pantaloni|falda|pantal[oó]n|saia|cal[cç]a|broek|spodnie|sp[oó]dnica)(?:e|en|er|n|s)?\b/i,
  tops:      /\b(top|blouse|shirt|tee|tank|bodysuit|cami|kurta|kurti|hemd|bluse|t-shirt|tshirt|polo|pullover|sweater|jumper|knit|chemise|chemisier|maillot|pull|camicia|camicetta|maglietta|maglia|maglione|camisa|blusa|playera|camiseta|camisola|jersey|overhemd|bloesje|trui)(?:e|en|er|n|s)?\b/i,
  dresses:   /\b(dress|jumpsuit|romper|gown|kleid|robe|combinaison|vestito|abito|tuta|vestido|mono|jurk)(?:e|en|er|n|s)?\b/i,
  sarees:    /\bsaree?s?\b/i,
  lehengas:  /\b(lehenga|choli|ghagra)s?\b/i,
  dupattas:  /\b(dupatta|stole|odhni)s?\b/i,
  kaftans:   /\b(kaftan|caftan|tunic|tunika|tunique|tunica|t[uú]nica)s?\b/i,
  suits:     /\b(suit|salwar|sharara|gharara|anarkali|anzug|costume|abito da uomo|traje|terno|pak)s?\b/i,
  pashminas: /\b(pashmina|shawl|schal|ch[aâ]le|scialle|chal|xale)s?\b/i,
  belts:     /\b(belt|sash|g[uü]rtel|ceinture|cintura|cintur[oó]n|cinto|riem)s?\b/i,
  scarves:   /\b(scarf|scarve|halstuch|fichu|foulard|sciarpa|fular|bufanda|cachecol|sjaal)s?\b/i,
  swimwear:  /\b(swim|bikini|swimsuit|swimwear|badeanzug|maillot de bain|costume da bagno|ba[ñn]ador|fato de banho|zwempak)s?\b/i,
  lingerie:  /\b(bra|brief|panty|panties|lingerie|underwear|sleepwear|nightwear|robe|unterw[aä]sche|dessous|biancheria|ropa interior|roupa interior|ondergoed|nachthemd|bademantel)s?\b/i,
  activewear:/\b(activewear|sportswear|athletic|gym|yoga|workout|sportbekleidung|tenue de sport|abbigliamento sportivo|ropa deportiva|sportkleding)s?\b/i,
};

// Regex-based fallback profile builder. Used as a safety net when the LLM
// detector fails or the catalog is too small to be worth a Gemini call.
function buildCatalogProfileRegex(selectedCollections, allProducts) {
  const cols = selectedCollections?.collections || [];
  const haystack = [
    ...cols.map(c => `${c.title} ${c.handle}`),
    ...allProducts.slice(0, 80).map(p => p.title || ""),
  ].join(" | ");

  const categories = {};
  for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    categories[cat] = pattern.test(haystack);
  }

  let archetype = "mixed";
  const c = categories;
  if (c.sarees || c.lehengas || c.dupattas || c.kaftans || c.suits || c.pashminas) {
    archetype = "indian-ethnic";
  } else if (c.lingerie && !c.dresses && !c.tops) {
    archetype = "lingerie";
  } else if (c.swimwear && !c.dresses && !c.outerwear) {
    archetype = "swimwear";
  } else if (c.activewear && !c.dresses && !c.outerwear) {
    archetype = "activewear";
  } else if (c.jewelry && !c.dresses && !c.tops && !c.bottoms) {
    archetype = "jewelry-only";
  } else if (c.dresses && c.shoes && c.bags) {
    archetype = "western-rtw";
  } else if (c.tops && c.bottoms && !c.dresses) {
    archetype = "separates";
  }
  return { archetype, categories, source: "regex" };
}

// LLM-based catalog profile detector. Sends collection titles + a sample of
// product titles to Gemini Lite and asks for a structured JSON of which
// categories are present and which archetype the store belongs to. Works for
// any language out of the box (German "Schuhe", Italian "Borse", Polish
// "Spodnie", Japanese "シャツ", etc.) without per-language regex maintenance.
//
// Falls back to the regex builder on any failure (network, parse error,
// schema mismatch). Cost ≈ $0.002 per analyze on Flash Lite, latency ~1-2s.
async function buildCatalogProfileLLM(selectedCollections, allProducts, debug) {
  try {
    const cols = selectedCollections?.collections || [];
    // Show up to 80 collections so we don't miss niche-but-essential categories
    // like the German "TSD - Schuhe" (4 products) which often sit at position
    // 40+ in catalogs that have hundreds of brand/seasonal collections.
    const colSummary = cols
      .slice(0, 80)
      .map(c => `- ${c.title} (handle: ${c.handle}${c.productsCount ? `, ${c.productsCount} products` : ""})`)
      .join("\n");
    const productSample = allProducts
      .slice(0, 60)
      .map(p => `- ${p.title}${p.type ? ` (type: ${p.type})` : ""}`)
      .join("\n");

    const prompt = `You are analyzing a fashion store's catalog to determine which product categories are present. The catalog may be in ANY language (English, German, French, Italian, Spanish, Portuguese, Dutch, Polish, Russian, Turkish, Greek, Hebrew, Arabic, Japanese, Chinese, Korean, etc.).

COLLECTION TITLES:
${colSummary}

SAMPLE PRODUCT TITLES:
${productSample}

For each category below, decide if the store sells products in that category, regardless of the language used in titles. Examples of cross-language equivalents:
- shoes: shoes / Schuhe / Chaussures / Scarpe / Zapatos / Sapatos / Schoenen / Buty / Παπούτσια / 鞋 / 신발 / 靴
- bags: bag / Tasche / Sac / Borsa / Bolso / Bolsa / Tas / Torba / Τσάντα / バッグ / 가방 / 包
- bottoms: pants/skirt / Hose+Rock / Pantalon+Jupe / Pantalone+Gonna / Pantalón+Falda
- tops: shirt/blouse / Hemd+Bluse / Chemise / Camicia / Camisa
- outerwear: jacket/coat / Jacke+Mantel / Veste+Manteau / Giacca+Cappotto
- dresses: dress / Kleid / Robe / Vestito / Vestido
- jewelry: jewelry/earrings/necklace / Schmuck / Bijoux / Gioielli / Joyas
- (similarly for sarees, lehengas, dupattas, kaftans, suits, pashminas, belts, scarves, swimwear, lingerie, activewear, fabrics)

Then assign ONE archetype that best describes the store overall:
- "indian-ethnic": sarees / lehengas / dupattas / kurtas / sherwanis dominate
- "lingerie": bras / panties / sleepwear dominate
- "swimwear": bikinis / swimsuits dominate
- "activewear": gym / sports / yoga / running gear dominates
- "jewelry-only": only earrings / necklaces / rings / bracelets
- "western-rtw": typical western ready-to-wear with dresses + shoes + bags
- "separates": tops + bottoms but no dresses (modular wardrobe)
- "fabrics": raw fabric / textile retailer
- "mixed": doesn't clearly fit any of the above

Return ONLY JSON, no markdown:
{
  "archetype": "<one of the above>",
  "categories": {
    "shoes": true|false,
    "bags": true|false,
    "jewelry": true|false,
    "outerwear": true|false,
    "bottoms": true|false,
    "tops": true|false,
    "dresses": true|false,
    "sarees": true|false,
    "lehengas": true|false,
    "dupattas": true|false,
    "kaftans": true|false,
    "suits": true|false,
    "pashminas": true|false,
    "belts": true|false,
    "scarves": true|false,
    "swimwear": true|false,
    "lingerie": true|false,
    "activewear": true|false
  },
  "detected_language": "<2-letter ISO code if non-English, else null>"
}`;

    const model = getGeminiModel(true); // Lite — text-only, cheap & fast
    const t = Date.now();
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(text);
    debug.track("catalogProfile (LLM)", { elapsed: Date.now() - t, archetype: parsed.archetype, lang: parsed.detected_language });

    // Schema-validate: must have archetype + categories object
    if (typeof parsed.archetype !== "string" || !parsed.categories || typeof parsed.categories !== "object") {
      throw new Error("malformed schema");
    }

    // Coerce all category values to booleans (defensive against string "true" etc.)
    const cats = {};
    for (const k of Object.keys(CATEGORY_PATTERNS)) {
      cats[k] = !!parsed.categories[k];
    }
    return { archetype: parsed.archetype, categories: cats, language: parsed.detected_language || null, source: "llm" };
  } catch (err) {
    debug.track("catalogProfile LLM failed, falling back to regex", { error: err.message });
    return null;
  }
}

async function buildCatalogProfile(selectedCollections, allProducts, debug) {
  // Try the LLM-based detector first — works for any language. Fall back to
  // regex on failure for resilience (no extra Gemini call needed for fallback).
  const llmResult = await buildCatalogProfileLLM(selectedCollections, allProducts, debug);
  if (llmResult) return llmResult;
  return buildCatalogProfileRegex(selectedCollections, allProducts);
}

function formatCatalogPreamble(profile) {
  if (!profile) return "";
  const present = Object.entries(profile.categories).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(profile.categories).filter(([, v]) => !v).map(([k]) => k);
  return `CATALOG REALITY (archetype: ${profile.archetype}):
- Categories present in this store: ${present.join(", ") || "(none detected)"}
- Categories NOT in this catalog:   ${missing.join(", ") || "(none)"}

CRITICAL CRITIC ADJUSTMENT: Do NOT auto-fail the "Missing shoes" or "Missing bag" critical rules if those categories are not in the catalog above. The buildOutfit substitute rule applies — accept jewellery, dupattas, scarves, belts, or other available accessories as valid fillers when shoes/bags genuinely don't exist in this catalog. Only flag these as critical violations if shoes/bags are listed as "present" above.

CRITICAL BUILDER ADJUSTMENT: Do not pick complements from categories not listed as "present" above. The catalog cannot fulfil them.

`;
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
  // Defensive: Gemini can return Shopify int64 IDs as strings or with rounded
  // precision. Try both the raw value, the string form, and the numeric form.
  const lookup = (id) => {
    if (id == null) return null;
    if (productMap.has(id)) return productMap.get(id);
    const asStr = String(id);
    if (productMap.has(asStr)) return productMap.get(asStr);
    const asNum = Number(id);
    if (Number.isFinite(asNum) && productMap.has(asNum)) return productMap.get(asNum);
    return null;
  };

  return (rawItems || [])
    .map(lookup)
    .filter(p => p && p.id !== anchorId && String(p.id) !== String(anchorId))
    .map(p => ({ id: p.id, title: p.title, handle: p.handle, price: p.price, image: p.image, vendor: p.vendor, collection: p.collection }));
}

function buildOutfitObj(anchor, items, outfitName) {
  const outfit = { anchor, items, outfit_name: outfitName };
  const total = [anchor, ...items].reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
  outfit.total_price = total.toFixed(2);
  return outfit;
}

// ─── Phase 3: Multimodal complement picking ──────────────────────────
//
// Two-stage replacement for the single text-only buildOutfit call.
// Mirrors the manual Saturday workflow:
//   Stage A (text):   shortlist 5 candidates per needed complement category
//   Stage B (vision): send anchor image + all candidate images to Gemini → final pick
//
// Catches metal-tone clashes, color-overload, set-vs-singles traps that text alone misses.

const SET_PRODUCT_PATTERN = /\b(set|combo|with jhumkas?|with maang ?tikka|set of \d+|matching|coordinated set|necklace set|jewell?ery set)\b/i;

function isProductASet(p) {
  return p && SET_PRODUCT_PATTERN.test(p.title || "");
}

const DEFAULT_SHORTLIST_PROMPT = `You are shortlisting complement candidates for a "Complete the Look" outfit at {{storeName}} (catalog archetype: {{archetype}}).

ANCHOR (image attached): {{anchorProduct}}

AVAILABLE COMPLEMENTS (grouped by collection):
{{availableCollections}}

Step 1 — Decide which 3-4 complement categories this anchor needs to form a complete outfit. Examples:
- Western dress anchor → shoes + bag + jewellery
- Saree anchor → blouse + earrings + necklace (+ optional bangle)
- Lehenga anchor → blouse + dupatta + necklace + earrings
- Top anchor → bottom + shoes + bag
- Outerwear anchor → dress (preferred) + shoes + bag, OR top + bottom + shoes + bag

Respect the CATALOG REALITY preamble — only choose categories that exist in the catalog.

Step 2 — For each chosen category, shortlist 5 best candidates by id. Quality over forced fits. Pick pieces that could plausibly work with this anchor based on title, price tier, color hints, and craft alignment. DO NOT pick the final item yet — just shortlist 5 per category.

Return ONLY JSON, no markdown:
{
  "shortlist": [
    {"category": "<category-name>", "ids": [<id1>, <id2>, <id3>, <id4>, <id5>]},
    {"category": "<category-name>", "ids": [...]},
    {"category": "<category-name>", "ids": [...]}
  ]
}`;

const DEFAULT_PICK_COMPLEMENTS_PROMPT = `You are the FINAL picker for a "Complete the Look" outfit at {{storeName}}.

ANCHOR (image attached at top): {{anchorProduct}}

CANDIDATES (images attached, grouped by category): see candidate sections below.

Pick exactly ONE candidate id from EACH category. Use the IMAGES (not just titles) to verify:

1. METAL TONE consistency — a "silver" item that visually renders gold-plated must be detected and either matched or excluded. The whole outfit must use ONE metal family (warm gold OR cool silver, never both).

2. COLOR HARMONY with the anchor — no jarring third hue. ≤2 chromatic hues + 1 metallic across the outfit. If anchor is vivid (red, fuchsia, emerald, cobalt, turquoise), prefer NEUTRAL complements (black, white, ivory, beige, nude, gold, silver).

3. SCALE / OCCASION match — daywear anchor → daywear complements (no maang-tikka or heavy bridal pieces). Bridal anchor → bridal-grade complements.

4. SET DETECTION — items flagged as "[SET]" already include multiple categories (e.g. "Necklace Set with Jhumkas and Maang Tikka" includes earrings + tikka). If you pick a SET, do NOT also pick separate earrings or other categories already covered by the set.

5. PRINT — if the anchor has a print, all complements must be SOLID. Never print + print.

{{criticFeedback}}

Give the outfit a short evocative name (2-4 words).

Return ONLY JSON, no markdown:
{
  "items": [<id1>, <id2>, <id3>],
  "outfit_name": "..."
}`;

async function pickComplementsMultimodal({
  anchor, allProducts, storeName, prompts, catalogProfile, selectedCollections,
  anchorImageParts, criticFeedback, debug,
}) {
  const model = getGeminiModel();
  const productMap = new Map(allProducts.map(p => [p.id, p]));
  const complementary = allProducts.filter(p =>
    p.id !== anchor.id && p.collection !== anchor.collection
  );
  const compGrouped = groupByCollection(complementary, selectedCollections);

  const anchorJson = JSON.stringify({
    id: anchor.id, title: anchor.title, type: anchor.type,
    price: anchor.price, collection: anchor.collection,
  });
  const catalogPreamble = formatCatalogPreamble(catalogProfile);

  // ── Stage A: text shortlist by category ─────────────────────────
  const shortlistPrompt = catalogPreamble + (prompts.shortlistComplements || DEFAULT_SHORTLIST_PROMPT)
    .replace("{{storeName}}", storeName)
    .replace("{{archetype}}", catalogProfile?.archetype || "unknown")
    .replace("{{anchorProduct}}", anchorJson)
    .replace("{{availableCollections}}", formatGrouped(compGrouped));

  const tA = Date.now();
  const resultA = await model.generateContent([shortlistPrompt, ...anchorImageParts]);
  const uA = resultA.response.usageMetadata;
  const textA = resultA.response.text().replace(/```json\n?|\n?```/g, "").trim();
  debug.track(`shortlistComplements "${anchor.title}"`, { inputTokens: uA?.promptTokenCount, outputTokens: uA?.candidatesTokenCount, inputChars: shortlistPrompt.length, rawResponse: textA, elapsed: Date.now() - tA });

  let parsedA;
  try {
    parsedA = JSON.parse(textA);
  } catch (err) {
    debug.track(`shortlistComplements parse failed`, { error: err.message });
    return null;
  }

  const shortlistByCategory = (parsedA.shortlist || [])
    .map(group => ({
      category: String(group.category || "uncategorized"),
      products: (group.ids || [])
        .filter(id => productMap.has(id) && id !== anchor.id)
        .slice(0, 5)
        .map(id => productMap.get(id)),
    }))
    .filter(g => g.products.length > 0);

  if (shortlistByCategory.length < 2) {
    // Not enough categories to make a real outfit — bail out.
    debug.track("shortlistComplements insufficient", { categories: shortlistByCategory.length });
    return null;
  }

  // ── Stage B: multimodal vision pick ─────────────────────────────
  const candidateImageParts = [];
  for (const group of shortlistByCategory) {
    candidateImageParts.push(`\n--- ${group.category.toUpperCase()} CANDIDATES ---`);
    // Fetch images for this category in parallel.
    const imageResults = await Promise.all(
      group.products.map(async (p) => ({
        product: p,
        image: p.image ? await fetchImageAsBase64(p.image) : null,
      }))
    );
    for (const { product, image } of imageResults) {
      if (image) {
        candidateImageParts.push({ inlineData: { mimeType: image.contentType, data: image.base64 } });
      }
      const setTag = isProductASet(product) ? " [SET]" : "";
      candidateImageParts.push(`${group.category} id=${product.id}${setTag}: "${product.title}" — ${product.price}`);
    }
  }

  const feedbackBlock = criticFeedback
    ? `\n\nCRITIC FEEDBACK FROM PREVIOUS ATTEMPT (you MUST address these):\n${criticFeedback}\n`
    : "";

  const pickPrompt = catalogPreamble + (prompts.pickComplements || DEFAULT_PICK_COMPLEMENTS_PROMPT)
    .replace("{{storeName}}", storeName)
    .replace("{{anchorProduct}}", anchorJson)
    .replace("{{criticFeedback}}", feedbackBlock);

  const tB = Date.now();
  const resultB = await model.generateContent([pickPrompt, ...anchorImageParts, ...candidateImageParts]);
  const uB = resultB.response.usageMetadata;
  const textB = resultB.response.text().replace(/```json\n?|\n?```/g, "").trim();
  debug.track(`pickComplements "${anchor.title}"`, { inputTokens: uB?.promptTokenCount, outputTokens: uB?.candidatesTokenCount, candidates: candidateImageParts.filter(p => p.inlineData).length, rawResponse: textB, elapsed: Date.now() - tB });

  let parsedB;
  try {
    parsedB = JSON.parse(textB);
  } catch (err) {
    debug.track(`pickComplements parse failed`, { error: err.message });
    return null;
  }

  return {
    items: parsedB.items || [],
    outfit_name: parsedB.outfit_name || "Outfit",
  };
}

// ─── Phase 6: Level 2 — auto-generated per-store critic config ────
//
// Goes beyond Phase 1's regex-detected catalog preamble. Asks Gemini to
// inspect the catalog (profile + sample products with images) and output a
// structured JSON config of store-specific critic adjustments — brand voice,
// category grammar, occasion rules, banned/required complements.
// Generated once per store, cached in DynamoDB, reused on every analyze.

const STORE_CRITIC_CONFIG_VERSION = 1; // Bump to invalidate stale per-store configs.
const STORE_CRITIC_CONFIG_KEY = (domain) => `demo_critic_config_${domain}`;

const DEFAULT_GENERATE_STORE_CRITIC_PROMPT = `You are a senior fashion stylist analyzing a store to produce a STORE-SPECIFIC CRITIC CONFIG for an AI styling system.

STORE: {{storeName}} ({{domain}})
ARCHETYPE: {{archetype}}
CATEGORIES PRESENT: {{categoriesPresent}}
CATEGORIES MISSING: {{categoriesMissing}}

You are shown 8 sample products with images. Use them to detect the store's brand voice, craft language, and category grammar.

Produce a structured config that captures THIS store's styling rules — things a generic Western fashion critic would miss. Examples by archetype:

INDIAN ETHNIC: blouse + saree is NOT a "top + dress duplicate" but the saree's required companion; gold-zardozi sarees demand gold (not silver) jewellery; lehengas need both blouse AND dupatta; kaftan + maang-tikka is occasion-mismatched.

WESTERN LUXURY MINIMALIST (Toteme, The Row, Khaite): embellishment IS a violation — clean silhouettes and tonal monochrome are the brand voice; statement jewellery should be flagged; sneakers + tailoring is acceptable (modern luxury norm).

WESTERN MAXIMALIST (Ganni, Marni, Loewe Show): print + print is intentional, NOT a violation; vivid + chromatic complement is the brand voice; the "neutral complement to a vivid hero" rule should be RELAXED.

WESTERN OVERSIZED (Acne Studios, Lemaire, Balenciaga): oversized + wide-leg is intentional, NOT a silhouette clash; volume balance rules should be relaxed.

STREETWEAR / Y2K / DENIM-FORWARD: casual + casual is the point; sneakers always acceptable; chunky + chunky is signature.

LINGERIE: outfit IS bra + brief + robe — no shoes/bottoms expected; "missing bag" never applies.

KIDSWEAR: scale rules differently, no maximalist statement pieces; comfort/wash-care signals matter.

ATHLEISURE / SPORTSWEAR: matched track sets are correct; sneakers always acceptable; technical fabrics are the language.

If the store has NO distinct voice (generic Aritzia / ASOS / mid-market RTW), return mostly null/empty fields — that's fine, the master critic handles it. Only populate richly when you genuinely detect a brand-specific styling logic.

Return ONLY valid JSON in this exact schema (use null for unused fields):

{
  "brand_voice": "<2-4 word description, e.g. 'luxury bridal heritage', 'modern minimalist', 'streetwear maximalist'>",
  "skip_critical_rules": ["<rule names from master critic that are not applicable, e.g. 'Missing shoes', 'Missing bag', 'Print + print'>"],
  "category_grammar": [
    {
      "category": "<category name in this catalog, e.g. 'saree', 'lehenga', 'kaftan'>",
      "is_complete_garment": <true|false>,
      "required_companions": ["<companion category names>"],
      "forbidden_companions": ["<companion category names that violate this catalog's grammar>"]
    }
  ],
  "color_grammar": "<1-2 sentences on this store's color tolerance, e.g. 'jewel tones can pair with other jewel tones; western Vivid+Chromatic rule does not apply'>",
  "metal_tone_strictness": "<strict|relaxed|n_a>",
  "occasion_rules": "<1-2 sentences, e.g. 'bridal pieces require coordinated jewellery suite + dupatta; daywear must avoid maang tikka'>",
  "extra_critical_violations": ["<store-specific critical rules to ADD, max 3>"],
  "extra_minor_violations": ["<store-specific minor rules to ADD, max 3>"],
  "notes": "<one sentence summary for human reviewers>"
}

Be specific to THIS store. Generic Western RTW stores can return mostly empty/null fields — that's fine, the master critic handles them. Indian/streetwear/lingerie/luxury-niche stores should populate richly.`;

function validateStoreCriticConfig(raw) {
  // Defensive Zod-lite validation. Returns null if structure is unsafe.
  if (!raw || typeof raw !== "object") return null;
  const out = {
    brand_voice: typeof raw.brand_voice === "string" ? raw.brand_voice.slice(0, 80) : null,
    skip_critical_rules: Array.isArray(raw.skip_critical_rules) ? raw.skip_critical_rules.filter(s => typeof s === "string").slice(0, 10) : [],
    category_grammar: Array.isArray(raw.category_grammar) ? raw.category_grammar.filter(g => g && typeof g === "object" && typeof g.category === "string").slice(0, 10).map(g => ({
      category: String(g.category).slice(0, 50),
      is_complete_garment: !!g.is_complete_garment,
      required_companions: Array.isArray(g.required_companions) ? g.required_companions.filter(s => typeof s === "string").slice(0, 6) : [],
      forbidden_companions: Array.isArray(g.forbidden_companions) ? g.forbidden_companions.filter(s => typeof s === "string").slice(0, 6) : [],
    })) : [],
    color_grammar: typeof raw.color_grammar === "string" ? raw.color_grammar.slice(0, 400) : null,
    metal_tone_strictness: ["strict", "relaxed", "n_a"].includes(raw.metal_tone_strictness) ? raw.metal_tone_strictness : null,
    occasion_rules: typeof raw.occasion_rules === "string" ? raw.occasion_rules.slice(0, 400) : null,
    extra_critical_violations: Array.isArray(raw.extra_critical_violations) ? raw.extra_critical_violations.filter(s => typeof s === "string").slice(0, 3) : [],
    extra_minor_violations: Array.isArray(raw.extra_minor_violations) ? raw.extra_minor_violations.filter(s => typeof s === "string").slice(0, 3) : [],
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 300) : null,
  };
  return out;
}

function formatStoreCriticAddendum(config) {
  if (!config) return "";
  const lines = ["", "── STORE-SPECIFIC CRITIC ADJUSTMENTS ──"];
  if (config.brand_voice) lines.push(`Brand voice: ${config.brand_voice}`);
  if (config.skip_critical_rules?.length) {
    lines.push(`Skip these built-in critical rules (do not auto-fail on them): ${config.skip_critical_rules.join(", ")}`);
  }
  if (config.category_grammar?.length) {
    lines.push("Category grammar for THIS store:");
    for (const g of config.category_grammar) {
      const parts = [`  - ${g.category}: ${g.is_complete_garment ? "complete garment" : "needs companions"}`];
      if (g.required_companions?.length) parts.push(`required companions = ${g.required_companions.join(", ")}`);
      if (g.forbidden_companions?.length) parts.push(`forbidden = ${g.forbidden_companions.join(", ")}`);
      lines.push(parts.join("; "));
    }
  }
  if (config.color_grammar) lines.push(`Color grammar: ${config.color_grammar}`);
  if (config.metal_tone_strictness && config.metal_tone_strictness !== "n_a") {
    lines.push(`Metal-tone strictness: ${config.metal_tone_strictness}`);
  }
  if (config.occasion_rules) lines.push(`Occasion rules: ${config.occasion_rules}`);
  if (config.extra_critical_violations?.length) {
    lines.push(`EXTRA CRITICAL violations specific to this store:\n  - ${config.extra_critical_violations.join("\n  - ")}`);
  }
  if (config.extra_minor_violations?.length) {
    lines.push(`EXTRA MINOR violations specific to this store:\n  - ${config.extra_minor_violations.join("\n  - ")}`);
  }
  lines.push("─────────────────────────────────────", "");
  return lines.join("\n");
}

async function loadStoreCriticConfig(domain) {
  try {
    const docClient = dynamoClient.getDocClient();
    const result = await docClient.send(new GetCommand({
      TableName: config.dynamodb.tables.cache,
      Key: { id: STORE_CRITIC_CONFIG_KEY(domain) },
    }));
    if (!result.Item || result.Item.version !== STORE_CRITIC_CONFIG_VERSION) return null;
    return result.Item.config || null;
  } catch {
    return null;
  }
}

async function saveStoreCriticConfig(domain, configObj) {
  try {
    const docClient = dynamoClient.getDocClient();
    await docClient.send(new PutCommand({
      TableName: config.dynamodb.tables.cache,
      Item: {
        id: STORE_CRITIC_CONFIG_KEY(domain),
        storeId: DEMO_STORE_ID,
        version: STORE_CRITIC_CONFIG_VERSION,
        config: configObj,
        createdAt: Date.now(),
      },
    }));
  } catch (err) {
    console.error(`[StoreCriticConfig] save failed for ${domain}:`, err.message);
  }
}

async function generateStoreCriticConfig({ domain, storeName, catalogProfile, sampleProducts, prompts, debug }) {
  // Generate for ALL archetypes — Western RTW has the highest brand-voice variance
  // (Toteme minimalism vs Ganni maximalism vs Acne oversized-on-oversized vs The Row
  // sneakers-with-tailoring), so per-store configs help even more there. If Gemini
  // sees a generic Aritzia-style catalog with no distinct voice, it returns mostly
  // empty fields and the master critic handles the outfit unchanged. No downside.
  try {
    const present = Object.entries(catalogProfile?.categories || {}).filter(([, v]) => v).map(([k]) => k).join(", ");
    const missing = Object.entries(catalogProfile?.categories || {}).filter(([, v]) => !v).map(([k]) => k).join(", ");
    const promptText = (prompts.generateStoreCriticConfig || DEFAULT_GENERATE_STORE_CRITIC_PROMPT)
      .replace("{{storeName}}", storeName || "the store")
      .replace("{{domain}}", domain)
      .replace("{{archetype}}", catalogProfile?.archetype || "unknown")
      .replace("{{categoriesPresent}}", present || "(none)")
      .replace("{{categoriesMissing}}", missing || "(none)");

    // Attach up to 8 sample product images for visual context.
    const samples = (sampleProducts || []).filter(p => p.image).slice(0, 8);
    const imageData = await Promise.all(samples.map(p => fetchImageAsBase64(p.image)));

    const parts = [promptText];
    for (let i = 0; i < samples.length; i++) {
      const img = imageData[i];
      if (img) parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
      parts.push(`(Sample: "${samples[i].title}" — ${samples[i].collection})`);
    }

    const model = getGeminiModel();
    const t = Date.now();
    const result = await model.generateContent(parts);
    const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
    debug.track("generateStoreCriticConfig", { domain, elapsed: Date.now() - t, rawResponse: text });

    const parsed = JSON.parse(text);
    const validated = validateStoreCriticConfig(parsed);
    if (!validated) {
      debug.track("storeCriticConfig validation failed", { rawKeys: Object.keys(parsed || {}) });
      return null;
    }
    return validated;
  } catch (err) {
    debug.track("generateStoreCriticConfig failed", { error: err.message });
    return null;
  }
}

// ─── Phase 5: Cross-outfit triptych diversity QA (log-only) ────────
//
// After all 3 outfits pass the per-anchor critic, rate the collection as a
// whole: are the 3 anchors visually distinct enough to feel like a triptych?
// V1 logs only — once we have data on real demos, V2 can re-roll the weak slot.
async function crossOutfitDiversityCheck(outfits, debug) {
  if (!Array.isArray(outfits) || outfits.length < 3) return outfits;
  const anchorsWithImages = outfits.filter(o => o?.anchor?.image).slice(0, 3);
  if (anchorsWithImages.length < 3) return outfits;

  try {
    const model = getGeminiModel();
    const imageData = await Promise.all(
      anchorsWithImages.map(o => fetchImageAsBase64(o.anchor.image))
    );

    const prompt = `These are 3 anchor products for a "Try Another Product" demo carousel. The slots represent THE WOW (slot 1), THE RANGE SIGNAL (slot 2), and THE EVERYDAY HERO (slot 3).

Rate the triptych's visual diversity 1-10. A 10 means three completely distinct outfit universes (different dominant colors, different categories or sub-styles, different occasions/moods). Reject (score <7) if any 2 anchors:
- share dominant color
- share the same category sub-style (e.g. two bridal lehengas)
- share the same mood (e.g. two evening pieces)

Return ONLY JSON: {"score": <1-10>, "weakest_slot": <1|2|3|null>, "reason": "..."}`;

    const parts = [prompt];
    for (let i = 0; i < anchorsWithImages.length; i++) {
      const img = imageData[i];
      if (img) {
        parts.push({ inlineData: { mimeType: img.contentType, data: img.base64 } });
      }
      parts.push(`(SLOT ${i + 1}: ${anchorsWithImages[i].anchor.title})`);
    }

    const t = Date.now();
    const result = await model.generateContent(parts);
    const text = result.response.text().replace(/```json\n?|\n?```/g, "").trim();
    debug.track("crossOutfitTriptychQA", { rawResponse: text, elapsed: Date.now() - t });

    const parsed = JSON.parse(text);
    console.log(`[TriptychQA] score=${parsed.score}/10 weakest_slot=${parsed.weakest_slot ?? "none"} reason=${parsed.reason || ""}`);
    // V1 is log-only. V2 (later) could re-roll the weakest slot via next anchor candidate.
  } catch (err) {
    debug.track("crossOutfitTriptychQA failed", { error: err.message });
  }
  return outfits;
}

async function buildOutfitForAnchor(anchor, allProducts, storeName, prompts, selectedCollections, catalogProfile, storeCriticConfig, debug) {
  const model = getGeminiModel();
  const productMap = new Map(allProducts.map(p => [p.id, p]));

  const complementary = allProducts.filter(p =>
    p.id !== anchor.id &&
    p.collection !== anchor.collection
  );
  const compGrouped = groupByCollection(complementary, selectedCollections);

  const anchorJson = JSON.stringify({ id: anchor.id, title: anchor.title, type: anchor.type, price: anchor.price, collection: anchor.collection });

  const catalogPreamble = formatCatalogPreamble(catalogProfile);
  const basePrompt = catalogPreamble + prompts.buildOutfit
    .replace("{{storeName}}", storeName)
    .replace("{{anchorProduct}}", anchorJson)
    .replace("{{availableCollections}}", formatGrouped(compGrouped));

  // Fetch anchor image once — reused across multimodal stages.
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

  // Phase 3: prefer the multimodal 2-stage picker if we have an anchor image
  // AND the catalog has enough complementary products to make a real shortlist.
  // If multimodal fails or is unavailable, fall back to the single-call build.
  const useMultimodal = anchorImageParts.length > 0 && complementary.length >= 6;

  // ── Attempt 1: Build outfit ─────────────────────────────────────
  let currentOutfit = null;
  const t1 = Date.now();
  if (useMultimodal) {
    const picked = await pickComplementsMultimodal({
      anchor, allProducts, storeName, prompts, catalogProfile, selectedCollections,
      anchorImageParts, criticFeedback: null, debug,
    });
    if (picked && picked.items?.length >= 2) {
      const parsed = parseOutfitItems(picked.items, productMap, anchor.id);
      if (parsed.length >= 2) {
        currentOutfit = buildOutfitObj(anchor, parsed, picked.outfit_name);
      }
    }
    debug.track(`buildOutfit (multimodal) "${anchor.title}"`, { elapsed: Date.now() - t1, items: currentOutfit?.items?.length || 0 });
  }

  if (!currentOutfit) {
    // Fallback: single-call legacy path.
    const result1 = await model.generateContent([basePrompt, ...anchorImageParts]);
    const u1 = result1.response.usageMetadata;
    debug.track(`buildOutfit (single) "${anchor.title}"`, { inputTokens: u1?.promptTokenCount, outputTokens: u1?.candidatesTokenCount, inputChars: basePrompt.length, rawResponse: result1.response.text(), elapsed: Date.now() - t1 });
    try {
      const data1 = JSON.parse(result1.response.text().replace(/```json\n?|\n?```/g, "").trim());
      currentOutfit = buildOutfitObj(anchor, parseOutfitItems(data1.items, productMap, anchor.id), data1.outfit_name);
    } catch (err) {
      console.error(`[Demo] Build attempt 1 failed for "${anchor.title}":`, err.message);
      return null;
    }
  }

  // ── Critic 1 ─────────────────────────────────────────────────────
  const review1 = await criticOutfit(currentOutfit, prompts, catalogProfile, storeCriticConfig, debug);
  if (review1.approved) return currentOutfit;

  // ── Attempt 2: Rebuild with critic feedback ─────────────────────
  const formatIssues = (review) => (review.issues || []).map(i =>
    typeof i === 'string' ? `- ${i}` : `- [${i.severity}] ${i.rule}: ${i.description}`
  ).join("\n");

  const criticFeedbackText = `Score ${review1.score}/10. Issues:\n${formatIssues(review1)}${review1.fix_instruction ? `\nFix instruction: ${review1.fix_instruction}` : ""}`;

  let lastReview = review1;
  let bestOutfit = currentOutfit;
  let bestScore = review1.score || 0;

  try {
    const t2 = Date.now();
    let rebuiltOutfit = null;
    if (useMultimodal) {
      const picked2 = await pickComplementsMultimodal({
        anchor, allProducts, storeName, prompts, catalogProfile, selectedCollections,
        anchorImageParts, criticFeedback: criticFeedbackText, debug,
      });
      if (picked2 && picked2.items?.length >= 2) {
        rebuiltOutfit = buildOutfitObj(anchor, parseOutfitItems(picked2.items, productMap, anchor.id), picked2.outfit_name || currentOutfit.outfit_name);
      }
      debug.track(`rebuild (multimodal) "${anchor.title}"`, { elapsed: Date.now() - t2 });
    }
    if (!rebuiltOutfit) {
      const rebuildPrompt = basePrompt + `

IMPORTANT — PREVIOUS ATTEMPT WAS REJECTED BY THE CRITIC (Score: ${review1.score}/10):
Issues found:
${formatIssues(review1)}
${review1.fix_instruction ? `\nFIX INSTRUCTION: ${review1.fix_instruction}` : ''}

You MUST fix these issues. Follow the fix instruction exactly. Pick DIFFERENT items that resolve the problems above. Do NOT repeat the same mistakes.`;

      const result2 = await model.generateContent([rebuildPrompt, ...anchorImageParts]);
      const u2 = result2.response.usageMetadata;
      const text2 = result2.response.text().replace(/```json\n?|\n?```/g, "").trim();
      debug.track(`rebuild (single) "${anchor.title}"`, { inputTokens: u2?.promptTokenCount, outputTokens: u2?.candidatesTokenCount, inputChars: rebuildPrompt.length, rawResponse: text2, elapsed: Date.now() - t2 });
      const data2 = JSON.parse(text2);
      const items2 = parseOutfitItems(data2.items, productMap, anchor.id);
      if (items2.length >= 2) {
        rebuiltOutfit = buildOutfitObj(anchor, items2, data2.outfit_name || currentOutfit.outfit_name);
      }
    }

    if (rebuiltOutfit) {
      currentOutfit = rebuiltOutfit;
      // --- Critic 2 ---
      lastReview = await criticOutfit(currentOutfit, prompts, catalogProfile, storeCriticConfig, debug);
      if (lastReview.approved) return currentOutfit;
      if ((lastReview.score || 0) > bestScore) {
        bestOutfit = currentOutfit;
        bestScore = lastReview.score || 0;
      }
      console.log(`[Critic] "${anchor.title}": rebuild also rejected (score ${lastReview.score}/10)`);
    }
  } catch (err) {
    console.error(`[Critic] Rebuild failed for "${anchor.title}":`, err.message);
  }

  // No attempt cleared the demo threshold — fall back to the best attempt
  // if it scored at least 6 and has at least 2 items. Below 6 the outfit
  // typically has at least one major flaw visible to a CEO; better to drop
  // the slot than to ship a weak demo. This floor used to be 3 (pre-Phase 4)
  // but with the new ≥9 demo threshold and stronger multimodal builder the
  // realistic worst case after a rebuild is ~7, so 6 is a safe floor.
  const fallbackFloor = Math.max(6, DEMO_APPROVAL_THRESHOLD - 3);
  if (bestOutfit?.items?.length >= 2 && bestScore >= fallbackFloor) {
    console.log(`[Demo] "${anchor.title}": all attempts below threshold ${DEMO_APPROVAL_THRESHOLD}, using best (score ${bestScore}/10, floor ${fallbackFloor})`);
    return bestOutfit;
  }

  console.log(`[Demo] "${anchor.title}": all outfit attempts failed (best score ${bestScore}/10, floor ${fallbackFloor}), returning null`);
  return null;
}

// Phase 4: demo-quality threshold. The critic prompt sets `approved` at score ≥7,
// but for the public demo we want ≥ this threshold to count as "ship it without rebuild".
// 9 = matches my Saturday curation bar. 7 = old behaviour. Configurable via env.
const DEMO_APPROVAL_THRESHOLD = parseInt(process.env.DEMO_CRITIC_THRESHOLD || "9", 10);

// ─── Phase 7: slot-templated critic prompt ──────────────────────────
//
// Replaces the hand-written master critic prompt's hardcoded universal rules
// (e.g. "Missing shoes — auto-fail") with conditional blocks that are only
// rendered when the catalog actually supports them. This means Gemini never
// even SEES rules that don't apply to the store — no more "please ignore
// this rule" prose hint that gets dropped under load.
//
// The template uses a tiny subset of Mustache-style syntax:
//   {{var}}            — substitute env.var (or a top-level variable)
//   {{#if env.flag}}…{{/if}}        — include block if env.flag is truthy
//   {{#unless env.flag}}…{{/unless}} — include block if env.flag is falsy
// Nested blocks are supported. Anything that doesn't look like a tag is left
// untouched. If a template contains no slots, this is effectively a no-op
// over the simple {{storeName}}/{{anchor}}/{{items}} substitutions, so old
// untemplated prompts still work.

function renderCriticTemplate(template, vars) {
  if (!template) return "";

  // Resolve a dotted path like "env.requiresShoes" against vars. Returns the
  // value, or undefined if not found.
  const resolve = (path) => path
    .trim()
    .split(".")
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), vars);

  // Repeatedly evaluate the innermost {{#if}}…{{/if}} (or {{#unless}}) block
  // so nesting works. Each pass collapses at most one block.
  let prev = null;
  let cur = template;
  let safety = 50;
  while (cur !== prev && safety-- > 0) {
    prev = cur;
    cur = cur.replace(
      /\{\{#(if|unless)\s+([^}]+?)\}\}([\s\S]*?)\{\{\/\1\}\}/,
      (_m, kind, expr, body) => {
        const val = resolve(expr);
        const truthy = Array.isArray(val) ? val.length > 0 : !!val;
        const include = (kind === "if") ? truthy : !truthy;
        return include ? body : "";
      }
    );
  }

  // Substitute remaining {{var}} tokens. Anything unresolved becomes "".
  cur = cur.replace(/\{\{([^}#/][^}]*?)\}\}/g, (_m, expr) => {
    const v = resolve(expr);
    return v == null ? "" : String(v);
  });

  // Tidy up multiple blank lines left by removed blocks
  return cur.replace(/\n{3,}/g, "\n\n");
}

// Build the rendering environment from catalog profile + store-specific config.
// This is the single source of truth for "which rules apply to THIS store".
function buildCriticEnvironment(catalogProfile, storeCriticConfig) {
  const cats = catalogProfile?.categories || {};
  const archetype = catalogProfile?.archetype || "mixed";

  // Per-store-config-driven flags (with sensible defaults)
  const skipped = new Set((storeCriticConfig?.skip_critical_rules || []).map(s => s.toLowerCase()));
  const metalStrictness = storeCriticConfig?.metal_tone_strictness || "strict";

  // Archetype-driven defaults (let Gemini's per-store config still override)
  const isIndianEthnic = archetype === "indian-ethnic";
  const isLingerie = archetype === "lingerie";
  const isSwimwear = archetype === "swimwear";
  const isJewelryOnly = archetype === "jewelry-only";

  return {
    archetype,

    // Catalog-derived rule applicability (deterministic — no LLM trust needed)
    requiresShoes: cats.shoes === true && !skipped.has("missing shoes"),
    requiresBag: cats.bags === true && !skipped.has("missing bag"),

    // Layer/duplicate logic relaxation for ensemble-based traditions.
    // Trust category presence directly — mixed catalogs (e.g. The Grand Trunk
    // sells both Indian and Western pieces) should still get the saree
    // exception when the anchor is a saree/lehenga.
    sareeIsCompleteEnsemble: cats.sarees === true || cats.lehengas === true || cats.dupattas === true,

    // Print + print rule — relaxed for catalogs where print is the brand identity
    printRuleEnabled: !skipped.has("print + print"),

    // Statement + statement — relaxed for maximalist brands
    statementRuleEnabled: !skipped.has("statement + statement"),

    // Color overload + vivid+chromatic — relaxed for jewel-tone traditions
    colorOverloadRuleEnabled: !isIndianEthnic && !skipped.has("color overload"),
    vividChromaticRuleEnabled: !isIndianEthnic && !skipped.has("vivid anchor + chromatic complement"),

    // Metal tone — disabled if the catalog/brand has no metal-tone story
    metalToneRuleEnabled: metalStrictness !== "n_a" && !skipped.has("conflicting metal tones"),

    // Cold/warm-weather — relaxed for archetypes where the rule doesn't apply cleanly
    seasonalMixRuleEnabled: !isLingerie && !isSwimwear && !skipped.has("cold-weather + warm-weather mix"),

    // Wrong-gender — keep on except for jewelry-only archetype (often unisex)
    wrongGenderRuleEnabled: !isJewelryOnly,

    // Brand voice and additional rules from the per-store config
    brandVoice: storeCriticConfig?.brand_voice || null,
    archetypeNote: isIndianEthnic
      ? "This is an INDIAN ETHNIC catalog. A blouse/choli is the EXPECTED companion to a saree or lehenga, NOT a duplicate. Dupattas + jewellery sets are part of a complete look, not separate violations."
      : isLingerie
      ? "This is a LINGERIE catalog. A complete outfit is bra + brief + (optional) robe — no shoes, no bottoms, no bags expected."
      : isSwimwear
      ? "This is a SWIMWEAR catalog. A complete outfit is swimsuit + (optional) cover-up + sunglasses/hat — no formal accessories expected."
      : null,
    // Pre-format list-y fields into strings so the simple {{#if}}/{{var}}
    // renderer doesn't need to know about iteration.
    extraCriticalViolations: storeCriticConfig?.extra_critical_violations || [],
    extraCriticalText: (storeCriticConfig?.extra_critical_violations || []).map(s => `- ${s}`).join("\n"),
    extraMinorViolations: storeCriticConfig?.extra_minor_violations || [],
    extraMinorText: (storeCriticConfig?.extra_minor_violations || []).map(s => `- ${s}`).join("\n"),
    categoryGrammar: storeCriticConfig?.category_grammar || [],
    categoryGrammarText: (storeCriticConfig?.category_grammar || []).map(g => {
      const parts = [`  - ${g.category}: ${g.is_complete_garment ? "complete garment" : "needs companions"}`];
      if (g.required_companions?.length) parts.push(`required = ${g.required_companions.join(", ")}`);
      if (g.forbidden_companions?.length) parts.push(`forbidden = ${g.forbidden_companions.join(", ")}`);
      return parts.join("; ");
    }).join("\n"),
  };
}

async function criticOutfit(outfit, prompts, catalogProfile, storeCriticConfig, debug) {
  if (!outfit.anchor || !outfit.items?.length) return { approved: true, score: 10, issues: [] };

  try {
    const critic = getGeminiModel();
    const anchorDesc = `"${outfit.anchor.title}" (${outfit.anchor.collection})`;
    const itemDescs = outfit.items.map((item, i) =>
      `${i}: "${item.title}" (${item.collection})`
    ).join("\n");

    const env = buildCriticEnvironment(catalogProfile, storeCriticConfig);
    const vars = {
      env,
      storeName: outfit.anchor.vendor || "the store",
      anchor: anchorDesc,
      items: itemDescs,
    };

    // Phase 7: render the critic prompt as a slot-filled template. The new
    // template uses {{#if env.flag}}…{{/if}} blocks so rules that don't apply
    // to this catalog are physically removed from the prompt rather than
    // overridden by prose. Falls back gracefully for older non-templated
    // prompts (renderCriticTemplate is a no-op on plain {{var}} substitutions).
    const criticTemplate = prompts.criticOutfit || prompts.criticOutfitFallback || "";
    const criticText = renderCriticTemplate(criticTemplate, vars);

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
    // Phase 4: override `approved` against demo threshold (default 9). The critic's
    // own `approved` flag uses ≥7, but demos should ship at ≥9 — anything lower
    // triggers a rebuild attempt. If a critical violation is present, never approve
    // regardless of score.
    const score = Number(review.score) || 0;
    const hasCritical = (review.issues || []).some(i =>
      typeof i === "object" && (i.severity === "critical" || /critical/i.test(i.severity || ""))
    );
    review.approved = !hasCritical && score >= DEMO_APPROVAL_THRESHOLD;
    review.demoThreshold = DEMO_APPROVAL_THRESHOLD;
    console.log(`[Critic] "${outfit.anchor.title}": score ${score}/10, approved: ${review.approved} (threshold ${DEMO_APPROVAL_THRESHOLD})${review.issues?.length ? ', issues: ' + review.issues.map(i => typeof i === 'string' ? i : i.rule).join(', ') : ''}`);
    return review;
  } catch (err) {
    console.error("Critic failed (non-blocking):", err.message);
    return { approved: true, score: 0, issues: [] };
  }
}

async function validateOutfit(outfit, mainGrouped, compGrouped, prompts, storeName) {
  if (!outfit.anchor || !outfit.items?.length) return outfit;

  try {
    const validator = getGeminiModel();
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
    const model = getGeminiModel();
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
        const val2 = getGeminiModel();
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

// ─── Leads Lookup (LeadsCompanyTable) ────────────────────────────────

// Fields we want from LeadsCompanyTable per domain
const LEADS_PROJECTION = [
  "#d", "company", "country", "brand_tier",
  "contact_first_name", "contact_last_name", "contact_email",
  "contact_title", "contact_linkedin", "contact_source",
  "dm_first_name", "dm_last_name", "dm_email",
  "dm_role", "dm_linkedin",
  "outreach_status", "personalization_message",
  "fashion_match", "ctl_fit", "ctl_existing",
  "store_url",
  "sales_revenue", "estimated_visits", "average_product_price",
].join(", ");

function shapeLead(item) {
  if (!item) return null;
  const firstName = item.contact_first_name || item.dm_first_name || "";
  const lastName = item.contact_last_name || item.dm_last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();

  // sales_revenue from StoreCensus is MONTHLY (USD). Annual = monthly × 12.
  const monthlyRevenue = item.sales_revenue != null ? Number(item.sales_revenue) : null;
  const annualRevenue = Number.isFinite(monthlyRevenue) ? Math.round(monthlyRevenue * 12) : null;
  const monthlyVisits = item.estimated_visits != null ? Number(item.estimated_visits) : null;
  const avgProductPrice = item.average_product_price != null ? Number(item.average_product_price) : null;

  return {
    company: item.company || null,
    country: item.country || null,
    brandTier: item.brand_tier || null,
    ownerName: fullName || null,
    ownerTitle: item.contact_title || item.dm_role || null,
    email: item.contact_email || item.dm_email || null,
    linkedin: item.contact_linkedin || item.dm_linkedin || null,
    source: item.contact_email
      ? (item.contact_source || "enriched")
      : (item.dm_email ? "storecensus" : null),
    outreachStatus: item.outreach_status || null,
    personalizationMessage: item.personalization_message || null,
    fashionMatch: item.fashion_match ?? null,
    ctlFit: item.ctl_fit ?? null,
    ctlExisting: item.ctl_existing ?? null,
    monthlyRevenue: Number.isFinite(monthlyRevenue) ? monthlyRevenue : null,
    annualRevenue,
    monthlyVisits: Number.isFinite(monthlyVisits) ? monthlyVisits : null,
    avgProductPrice: Number.isFinite(avgProductPrice) ? avgProductPrice : null,
  };
}

async function fetchLeadsByDomains(domains) {
  const map = {};
  if (!domains?.length) return map;

  const table = config.dynamodb.tables.leadsCompany;
  if (!table) return map;

  const docClient = dynamoClient.getDocClient();
  const unique = [...new Set(domains.filter(Boolean))];

  // BatchGet supports up to 100 keys per call
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const response = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [table]: {
            Keys: chunk.map(d => ({ domain: d })),
            ProjectionExpression: LEADS_PROJECTION,
            ExpressionAttributeNames: { "#d": "domain" },
          },
        },
      }));
      const items = response.Responses?.[table] || [];
      for (const item of items) {
        if (item.domain) map[item.domain] = shapeLead(item);
      }
    } catch (err) {
      console.error(`[demo/searches] LeadsCompanyTable lookup failed for chunk:`, err.message);
    }
  }
  return map;
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
        const outfit = r.result?.outfit;
        if (!outfit) return;
        outfitsByDomain[r.domain] = {
          ...outfit,
          currency: r.result?.store?.currency || "USD",
        };
      });

    // Visits from these countries (or with no resolvable country / localhost IP) are
    // treated as internal/test traffic and excluded from "real" visit counts.
    const TEST_COUNTRIES = new Set(["Romania"]);
    const isLocalIp = (ip) => {
      if (!ip) return true;
      const v = String(ip).replace(/^::ffff:/, ""); // strip IPv4-mapped IPv6 prefix
      if (v === "unknown" || v === "::1" || v === "localhost") return true;
      if (v.startsWith("127.")) return true;        // 127.0.0.0/8 loopback
      if (v.startsWith("10.")) return true;         // private 10.0.0.0/8
      if (v.startsWith("192.168.")) return true;    // private 192.168.0.0/16
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true; // private 172.16.0.0/12
      return false;
    };
    const isExternalVisit = (v) => {
      if (isLocalIp(v.ip)) return false;        // localhost / private network → internal
      if (!v.country) return false;             // no geo resolved → likely local/test
      if (TEST_COUNTRIES.has(v.country)) return false;
      return true;
    };

    const stores = results
      .filter(r => r.id?.startsWith("demo_visits_"))
      .map(r => {
        const allVisits = r.visits || [];
        const externalVisits = allVisits.filter(isExternalVisit);
        return {
          domain: r.domain,
          storeName: r.storeName,
          visits: allVisits.slice(0, 10),
          totalVisits: r.totalVisits || 0,
          lastVisit: r.lastVisit,
          cachedHits: allVisits.filter(v => v.fromCache).length,
          freshHits: allVisits.filter(v => !v.fromCache).length,
          // Real visits = visits not from our test country (Romania)
          externalVisits: externalVisits.length,
          uniqueExternalCountries: [...new Set(externalVisits.map(v => v.country).filter(Boolean))].length,
        };
      })
      .sort((a, b) => {
        // Hot leads (multiple external visits) first, then by last visit
        if (b.externalVisits !== a.externalVisits && (b.externalVisits >= 2 || a.externalVisits >= 2)) {
          return b.externalVisits - a.externalVisits;
        }
        return (b.lastVisit || 0) - (a.lastVisit || 0);
      });

    // Enrich each store with lead/contact data from LeadsCompanyTable
    const leadsByDomain = await fetchLeadsByDomains(stores.map(s => s.domain));
    for (const store of stores) {
      store.lead = leadsByDomain[store.domain] || null;
    }

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

// ─── Manual Seed ─────────────────────────────────────────────────────

router.post("/seed", async (req, res) => {
  try {
    const { input, dryRun } = req.body || {};
    if (!input || typeof input !== "string" || !input.trim()) {
      return res.status(400).json({ error: "Field 'input' (string) is required" });
    }
    const steps = [];
    const result = await seedDemoCache(input, {
      dryRun: !!dryRun,
      onStep: (msg) => steps.push(msg),
    });
    res.json({ ...result, steps });
  } catch (err) {
    console.error("Demo seed error:", err);
    res.status(500).json({ error: err.message || "Failed to seed demo cache" });
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
    // Minimal noise floor only — admit any collection with ≥2 products. The
    // language-agnostic noise filters (no Sale/Brand/Gift Cards) live in the
    // selectCollections prompt and handle the actual quality filtering in any
    // language. The old ≥5 threshold accidentally killed legitimate niche
    // accessory categories (e.g. a German store's "TSD - Schuhe" with 4
    // products), causing critic to fail with "Missing shoes" downstream.
    let collectionsWithProducts = collections.filter(c => c.productsCount >= 2);

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

          // Phase 1: build catalog profile once per analyze run.
          // LLM-based detection (Flash Lite) — works for any language.
          // We pass the FULL set of collections-with-products (not just the
          // Gemini-selected 10) so the detector knows everything the store
          // sells — Schuhe/Taschen/etc. that didn't make the styling shortlist
          // still count for "what categories this catalog has".
          const profileCollections = { collections: collectionsWithProducts };
          const catalogProfile = await buildCatalogProfile(profileCollections, allProducts, debug);
          debug.track("catalogProfile", { archetype: catalogProfile.archetype, source: catalogProfile.source, categories: catalogProfile.categories });

          // Phase 6: load existing per-store critic config from cache.
          // If missing, generate it in the background for ANY archetype so it's
          // available on the next analyze. We DO NOT block the current analyze
          // on this — first demo uses the master critic + Phase 1 preamble;
          // second demo onwards uses the tailored config. Generated config may
          // be empty/null-heavy for generic catalogs (no harm — master critic
          // handles them as before); rich for stores with distinct brand voice.
          let storeCriticConfig = await loadStoreCriticConfig(domain);
          if (!storeCriticConfig) {
            const samplesForGen = allProducts.filter(p => p.image).slice(0, 8);
            generateStoreCriticConfig({
              domain, storeName: store.name, catalogProfile,
              sampleProducts: samplesForGen, prompts, debug,
            }).then(cfg => {
              if (cfg) {
                saveStoreCriticConfig(domain, cfg);
                console.log(`[StoreCriticConfig] generated for ${domain} (archetype=${catalogProfile.archetype}, brand_voice=${cfg.brand_voice || 'n/a'})`);
              }
            }).catch(() => {});
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
            // Gemini #2: Select 3 anchors via 2-stage triptych picker (text shortlist + multimodal pick)
            const anchors = await selectAnchors(allProducts, selectedCollections, store.name, prompts, catalogProfile, debug);

            if (anchors.length === 0) {
              useCollectionApproach = false;
            } else {
              // Build 3 outfits in parallel
              const outfitPromises = anchors.slice(0, 3).map(anchor =>
                buildOutfitForAnchor(anchor, allProducts, store.name, prompts, selectedCollections, catalogProfile, storeCriticConfig, debug)
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
                // Phase 5: cross-outfit diversity QA (log-only).
                // Runs in background so it doesn't delay the SSE response.
                crossOutfitDiversityCheck(outfits, debug).catch(() => {});

                completeData = {
                  store: { name: store.name, domain, currency: store.currency, archetype: catalogProfile.archetype },
                  outfit: outfits[0],
                  alternativeOutfits: outfits.slice(1),
                  productCount: totalProducts,
                  collectionCount: validHandles.length,
                  catalogProfile,
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

    // Phase 1: catalog profile from the flat product list (no selectedCollections context).
    const fallbackProfile = await buildCatalogProfile(null, allProducts, debug);
    debug.track("catalogProfile (fallback)", { archetype: fallbackProfile.archetype, source: fallbackProfile.source, categories: fallbackProfile.categories });

    // Phase 6: load store critic config (no background generation in fallback path).
    const fallbackStoreCriticConfig = await loadStoreCriticConfig(domain);

    const outfit = await buildOutfitForAnchor(anchor, allProducts, store.name, prompts, null, fallbackProfile, fallbackStoreCriticConfig, debug);

    if (!outfit || !outfit.items?.length) {
      sendSSE(res, "error", {
        message: "We couldn't generate a quality outfit for this store. The catalog may lack the product variety needed for styling. Contact us at adrian@askruna.ai for help.",
      });
      return res.end();
    }

    const completeData = {
      store: { name: store.name, domain, currency: store.currency, archetype: fallbackProfile.archetype },
      outfit,
      alternativeOutfits: [],
      productCount: allProducts.length,
      collectionCount: collections.length,
      catalogProfile: fallbackProfile,
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
