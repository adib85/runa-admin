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

// ─── Fashion Days (non-Shopify) Support ────────────────────────────────
// Fashion Days isn't on Shopify, so we can't use /meta.json or
// /products/{handle}.json. Instead we parse the input text manually
// (the format is deterministic: "Outfit N:" header + "(HERO)" prefix on
// the anchor) and scrape each product page for the data we need (title,
// image, price, brand) directly from og: meta tags + the embedded
// gtmProductData JSON object.

const FASHION_DAYS_HOST = "fashiondays.ro";

function isFashionDaysInput(rawText) {
  return /fashiondays\.ro/i.test(rawText || "");
}

function parseFashionDaysInput(rawText) {
  const lines = rawText.split(/\r?\n/);
  const outfits = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Outfit\s+\d+/i.test(line)) {
      if (current) outfits.push(current);
      current = { hero: null, items: [] };
      continue;
    }
    if (!current) {
      // Tolerate stray content before the first "Outfit N:" header by
      // creating an implicit first outfit.
      current = { hero: null, items: [] };
    }
    const isHero = /^\(HERO\)/i.test(line);
    const url = line.replace(/^\(HERO\)\s*/i, "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (isHero) current.hero = url;
    else current.items.push(url);
  }
  if (current) outfits.push(current);

  // Drop any outfits without a hero AND fall back to the first item if
  // the (HERO) marker was missing — we don't want to silently lose data.
  return outfits
    .map((o) => {
      if (!o.hero && o.items.length) {
        return { hero: o.items[0], items: o.items.slice(1) };
      }
      return o;
    })
    .filter((o) => o.hero);
}

function extractMeta(html, property) {
  // Tolerate either order ("property=… content=…" or "content=… property=…")
  // and either single or double quotes.
  const re = new RegExp(
    `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

function extractAllMeta(html, property) {
  const re = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
    "gi"
  );
  const re2 = new RegExp(
    `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
    "gi"
  );
  const all = new Set();
  let m;
  while ((m = re.exec(html)) !== null) all.add(m[1]);
  while ((m = re2.exec(html)) !== null) all.add(m[1]);
  return [...all];
}

function extractGtmProduct(html) {
  // gtmProductData has a `product` key with name/brandName/price/productId.
  const m = html.match(/var\s+gtmProductData\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    return obj?.product || null;
  } catch {
    return null;
  }
}

function extractJsonLdPrice(html) {
  // The product page embeds a JSON-LD-ish block with `"price": "97.36"`.
  const m = html.match(/"price"\s*:\s*"([\d.]+)"/);
  return m ? m[1] : null;
}

function fashionDaysSlugFromUrl(url) {
  // /p/<slug>-p<id>-<variant>/  → use slug as a stable handle for the demo
  // breadcrumb path. Falls back to the full path if the regex misses.
  const m = url.match(/\/p\/([^/?#]+)/i);
  return m ? m[1] : url.replace(/^https?:\/\/[^/]+\//, "");
}

function fashionDaysProductIdFromUrl(url) {
  const m = url.match(/-p(\d+)-/i);
  return m ? Number(m[1]) : null;
}

function titleCaseRoWord(w) {
  if (!w) return w;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// Tencent EdgeOne (Fashion Days' WAF) blocks node-fetch's TLS fingerprint
// with a captcha challenge page. Node's native fetch (undici) gets through
// cleanly, so use it specifically for fashiondays.ro.
async function fashionDaysFetch(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFashionDaysProduct(url) {
  const res = await fashionDaysFetch(url, 15000);
  if (!res.ok) {
    throw new Error(`Fashion Days fetch failed for ${url}: HTTP ${res.status}`);
  }
  const html = await res.text();

  const ogTitle = extractMeta(html, "og:title");
  const ogImageList = extractAllMeta(html, "og:image");
  const ogImage = ogImageList[0] || null;
  const gtm = extractGtmProduct(html);
  const jsonLdPrice = extractJsonLdPrice(html);

  const slug = fashionDaysSlugFromUrl(url);
  const productId =
    gtm?.productId || fashionDaysProductIdFromUrl(url) || slug;

  const title = (gtm?.name || ogTitle || titleCaseRoWord(slug.replace(/-/g, " "))).trim();
  const vendor = gtm?.brandName || "";
  const price = (gtm?.price ?? jsonLdPrice ?? 0).toString();

  if (!ogImage) {
    throw new Error(`No image found for ${url}`);
  }

  const collection = (gtm?.subClassification || gtm?.classification || "category")
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "-");

  return {
    id: productId,
    title,
    handle: slug,
    type: gtm?.subClassification || "",
    vendor,
    tags: [],
    price,
    image: ogImage,
    collection,
  };
}

async function buildFashionDaysOutfit({ hero, items }, index) {
  const anchorRaw = await fetchFashionDaysProduct(hero);
  const itemsResolved = [];
  for (const u of items) {
    const p = await fetchFashionDaysProduct(u);
    itemsResolved.push(p);
  }
  const anchor = { ...anchorRaw };
  const itemObjs = itemsResolved.map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    price: p.price,
    image: p.image,
    vendor: p.vendor,
    collection: p.collection,
  }));
  return buildOutfitObj(anchor, itemObjs, `Outfit ${index + 1}`);
}

async function seedFashionDaysFromInput(rawText, opts) {
  const { dryRun = false, onStep = () => {} } = opts;
  const domain = FASHION_DAYS_HOST;

  onStep("Parsing Fashion Days outfits...");
  const parsed = parseFashionDaysInput(rawText);
  if (!parsed.length) throw new Error("No outfits found in input");

  onStep(`Fetching ${parsed.reduce((n, o) => n + 1 + o.items.length, 0)} product pages...`);
  const outfits = [];
  for (const [i, o] of parsed.entries()) {
    onStep(`Building outfit ${i + 1}/${parsed.length}...`);
    const outfit = await buildFashionDaysOutfit(o, i);
    outfits.push(outfit);
  }

  // We don't really know exact catalog stats for Fashion Days. Use sensible
  // placeholders so the existing UI doesn't show "0 products / 0 collections".
  const payload = {
    store: {
      name: "Fashion Days",
      domain,
      currency: "RON",
      // Tells the demo's simulated PDP browser bar to render
      // "fashiondays.ro/p/<slug>" instead of "/products/<slug>" — Fashion
      // Days uses /p/ for product pages, so this keeps the mock realistic.
      productPathPrefix: "/p",
    },
    outfit: outfits[0],
    alternativeOutfits: outfits.slice(1),
    productCount: outfits.reduce((n, o) => n + 1 + (o.items?.length || 0), 0),
    collectionCount: parsed.length,
    isFashionDays: true,
  };

  if (!dryRun) {
    onStep(`Saving cache for demo_${domain}...`);
    await saveDemoCache(domain, "Fashion Days", payload);
  }

  return {
    payload,
    parsed: { domain, outfits: parsed },
    storeName: "Fashion Days",
    domain,
    dryRun,
  };
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
  return { name: data.name, currency: data.currency || "USD" };
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

  // Fashion Days bypass: not on Shopify, has its own scraping path.
  if (isFashionDaysInput(rawText)) {
    return seedFashionDaysFromInput(rawText, { dryRun, onStep });
  }

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
    store: { name: meta.name, domain, currency: meta.currency },
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
