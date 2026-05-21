/**
 * Base Provider
 * Abstract base class for all e-commerce providers
 * 
 * All providers must implement these methods:
 * - fetchProducts(options): Fetch products from the platform
 * - fetchCollections(options): Fetch collections/categories
 * - getShopData(): Get shop metadata (currency, etc.)
 * - transformProduct(rawProduct): Transform to unified format
 */

import fs from "fs";
import path from "path";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { config } from "@runa/config";
import { neo4jService, openaiService, pubnubService, dynamodbService } from "../services/index.js";
import { shopifyCategories } from "../utils/categories.js";
import { delay, retryOnDeadlock, geminiWithRetry, mapWithConcurrency } from "../utils/index.js";
import { generateAIDescription, rewriteDescriptionFromImage, generateSEO, isDimensionsOnly, isBagProduct } from "../services/ai-product-description.js";

export class BaseProvider {
  constructor(config) {
    this.shopName = config.shopName;
    this.accessToken = config.accessToken;
    this.channelId = config.channelId || `${config.shopName}_scan`;
    this.region = config.region || "us-east-1";
    this.forceAll = config.forceAll || false;
    this.demographic = config.demographic || "woman";
    this.descriptionLanguage = config.descriptionLanguage || "ro";
    this.rewriteDescriptions = config.rewriteDescriptions || false;
    this.geminiModel = config.geminiModel || null;
    this.maxProducts = config.maxProducts || null;
    this.dryRun = config.dryRun || false;
    this.sinceIso = config.sinceIso || null;
    this.rewriteHeroes = config.rewriteHeroes || false;
    
    // Services
    this.neo4j = neo4jService;
    this.openai = openaiService;
    this.pubnub = pubnubService;
    this.dynamodb = dynamodbService;
    
    // Cache
    this.embeddingCache = [];
  }

  // ==================== ABSTRACT METHODS (must be implemented) ====================

  async fetchProducts(options = {}) {
    throw new Error("fetchProducts must be implemented by provider");
  }

  async fetchCollections() {
    throw new Error("fetchCollections must be implemented by provider");
  }

  async getShopData() {
    throw new Error("getShopData must be implemented by provider");
  }

  transformProduct(rawProduct) {
    throw new Error("transformProduct must be implemented by provider");
  }

  // Provider type identifier
  get providerType() {
    throw new Error("providerType must be implemented by provider");
  }

  // ==================== SHARED METHODS ====================

  async sync() {
    console.log(`\n=== Starting ${this.providerType} Sync for ${this.shopName}${this.dryRun ? " [DRY RUN]" : ""} ===\n`);

    const appData = { id: "runa", appName: "Runa" };
    const storeData = { id: this.shopName, storeName: this.shopName };

    if (!this.dryRun) {
      await this.neo4j.createApplicationAndStore(storeData, appData);
    } else {
      console.log("  [dry-run] skipped neo4j.createApplicationAndStore");
    }

    await this.syncProducts();

    if (!this.dryRun) {
      await this.processContext();
    } else {
      console.log("\n  [dry-run] skipped processContext (would generate AI suggestions and write to DynamoDB/PubNub)");
    }

    console.log(`\n=== ${this.providerType} Sync Complete for ${this.shopName}${this.dryRun ? " [DRY RUN — nothing was saved]" : ""} ===\n`);
  }

  async syncProducts() {
    console.log("saving products started 1");
    console.log("shopName, region", this.shopName, this.region);

    const user = await this.dynamodb.getUserByShop(this.shopName, this.region);
    console.log("user", user);

    if (user && !this.dryRun) {
      user.syncInProgress = true;
      user.syncProgress = 0;
      await this.dynamodb.saveUser(user, this.region);
    }

    const collections = await this.fetchCollections();
    console.log("allCategories", collections);
    if (collections && collections.length > 0 && !this.dryRun) {
      await this.neo4j.createOrUpdateCategories(collections);
    } else if (this.dryRun) {
      console.log(`  [dry-run] skipped neo4j.createOrUpdateCategories (${collections?.length || 0} categories)`);
    }

    await this.fetchAndProcessProducts(user);
  }

  // ==================== SYNC PROGRESS TRACKING ====================

  get progressFilePath() {
    return path.resolve(`.sync-progress-${this.shopName.replace(/[^a-z0-9]/gi, '_')}.json`);
  }

  loadProgress() {
    try {
      if (!fs.existsSync(this.progressFilePath)) return null;
      const data = JSON.parse(fs.readFileSync(this.progressFilePath, "utf8"));
      const ageHours = (Date.now() - data.startedAt) / (1000 * 60 * 60);
      if (ageHours > 24) {
        console.log(`  [Resume] Found old progress file (${ageHours.toFixed(0)}h ago), ignoring`);
        fs.unlinkSync(this.progressFilePath);
        return null;
      }
      return data;
    } catch { return null; }
  }

  saveProgress(data) {
    try { fs.writeFileSync(this.progressFilePath, JSON.stringify(data), "utf8"); } catch {}
  }

  clearProgress() {
    try { if (fs.existsSync(this.progressFilePath)) fs.unlinkSync(this.progressFilePath); } catch {}
  }

  async fetchAndProcessProducts(user) {
    const appData = { id: "runa", appName: "Runa" };
    const storeData = { id: this.shopName, storeName: this.shopName };
    const demographicsData = [this.demographic];
    const defaultCategories = user?.defaultCategories || null;
    const shopData = await this.getShopData();
    console.log("shopData", shopData);

    let countProcessed = 0;
    let totalProductsSeen = 0;
    let count = 0;
    let cursor = null;
    let hasMore = true;

    // Check for interrupted sync to resume
    const savedProgress = this.forceAll ? this.loadProgress() : null;

    if (savedProgress) {
      console.log(`\n  [Resume] Found interrupted sync from ${new Date(savedProgress.startedAt).toLocaleString()}`);
      console.log(`  [Resume] Already processed: ${savedProgress.countProcessed} products`);
      console.log(`  [Resume] Resuming from cursor position\n`);

      if (savedProgress.providerState && this.restoreCursorState) {
        this.restoreCursorState(savedProgress.providerState);
      }
      countProcessed = savedProgress.countProcessed || 0;
      totalProductsSeen = savedProgress.totalProductsSeen || 0;
      count = savedProgress.count || 0;
    }

    const syncStartedAt = savedProgress?.startedAt || Date.now();
    const syncRunStartedAt = savedProgress?.syncRunStartedAt || new Date().toISOString();

    while (hasMore) {
      // Fetch batch of products (cap to remaining budget when --max is used)
      const remaining = this.maxProducts ? Math.max(0, this.maxProducts - totalProductsSeen) : Infinity;
      if (remaining === 0) break;
      const batchLimit = Math.min(20, remaining);
      const { products: rawBatch, nextCursor, hasNextPage } = await this.fetchProducts({ cursor, limit: batchLimit });
      const products = this.maxProducts ? rawBatch.slice(0, remaining) : rawBatch;
      hasMore = hasNextPage && (!this.maxProducts || (totalProductsSeen + products.length) < this.maxProducts);
      cursor = nextCursor;

      totalProductsSeen += products.length;
      if (!count) count = this.maxProducts || (totalProductsSeen + (hasMore ? 200 : 0));

      console.log(`\n=== Batch: ${products.length} products, Total: ${totalProductsSeen} ===`);

      if (products.length === 0) continue;

      const allProductIds = products.map(p => p.id);
      if (!this.dryRun) {
        await this.neo4j.stampLastSeenAt(this.shopName, allProductIds, syncRunStartedAt);
      }

      // Filter existing products (unless force mode or dry-run)
      let productsToProcess = products;
      if (!this.forceAll && !this.dryRun) {
        const existingIds = await this.neo4j.getExistingProductIds(
          this.shopName,
          products.map(p => p.id)
        );
        const existingProducts = products.filter(p => existingIds.has(String(p.id)));
        productsToProcess = products.filter(p => !existingIds.has(String(p.id)));
        console.log(`  Existing: ${existingProducts.length}, New: ${productsToProcess.length}`);
      } else if (this.dryRun) {
        console.log(`  [dry-run] processing all ${productsToProcess.length} products (skipped existing-id check)`);
      } else {
        console.log(`  Force mode: processing all ${productsToProcess.length} products`);
      }

      if (productsToProcess.length > 0) {
        const processedProducts = await this.processProducts(productsToProcess, defaultCategories, shopData);
        processedProducts.forEach(p => p.lastSeenAt = syncRunStartedAt);

        if (!this.dryRun) {
          await this.distributeProducts(processedProducts, storeData, appData, demographicsData);
        } else {
          for (const p of processedProducts) {
            console.log(`  [dry-run] would save: ${p.handle || p.id} — "${p.title}" — demographics=[${(p.detectedDemographics || demographicsData).join(", ")}] — category="${p.category}"`);
          }
        }

        countProcessed += productsToProcess.length;
        if (countProcessed > count) countProcessed = count;

        console.log(`  Progress: ${totalProductsSeen}/${count} (${((totalProductsSeen / count) * 100).toFixed(1)}%)`);
        if (!this.dryRun) {
          this.pubnub.publishProgress(this.channelId, countProcessed, count);
          await this.dynamodb.updateSyncProgress(this.shopName, countProcessed !== count, countProcessed, count, this.region);
        }
      }

      if (!this.dryRun) {
        this.saveProgress({
          startedAt: syncStartedAt,
          syncRunStartedAt,
          countProcessed,
          totalProductsSeen,
          count,
          providerState: this.getCursorState ? this.getCursorState() : null
        });
      }
    }

    if (!this.dryRun) {
      this.clearProgress();
      this.pubnub.publishProgress(this.channelId, countProcessed, count);
      await this.dynamodb.updateSyncProgress(this.shopName, false, countProcessed, count, this.region);
    }
    console.log(`\n✓ ${this.dryRun ? "[dry-run] simulated" : "Finalized"}: ${countProcessed} products`);
  }

  // ==================== AI VISION (color detection, beach classification) ====================

  /**
   * Detect product color from its image using Gemini vision.
   * Called once per product (not per variant).
   */
  async detectColorFromImage(product) {
    const imageUrl = product.image || product.images?.[0]?.src || product.images?.[0];
    if (!imageUrl || !config.gemini?.apiKey) return null;

    try {
      const fetch = (await import("node-fetch")).default;
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) return null;

      const imageBuffer = await imageResponse.buffer();
      const base64Image = imageBuffer.toString("base64");
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";

      const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
      const model = genAI.getGenerativeModel({
        model: config.gemini.model,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              color: { type: SchemaType.STRING, description: "Full color description for fashion matching. Include dominant color, secondary colors, patterns, and finishes. Examples: 'black with gold hardware', 'navy blue and white stripes', 'burgundy leather with silver buckle', 'floral print on cream base', 'solid camel'. Always in English, lowercase." }
            },
            required: ["color"]
          }
        }
      });

      const result = await geminiWithRetry(() => model.generateContent([
        `You are a fashion stylist analyzing product colors for outfit matching. Look at this product image and describe its colors in detail. Include the dominant color, any secondary colors, patterns (stripes, floral, plaid, etc.), and notable material finishes (metallic, matte, glossy, etc.). This will be used by an AI that combines fashion items into outfits, so be specific. Product title for context: "${product.title}". Return in English, lowercase.`,
        { inlineData: { mimeType: contentType, data: base64Image } }
      ]));

      const parsed = JSON.parse(result.response.text());
      const color = parsed.color?.toLowerCase()?.trim();
      if (color) {
        console.log(`  [Color] Detected "${color}" for "${product.title}"`);
        return color;
      }
    } catch (error) {
      console.log(`  [Color] Detection failed for "${product.title}": ${error.message}`);
    }
    return null;
  }

  /**
   * Classify beach products into specific subcategories using Gemini vision.
   * Only called when a product's category matches "de plajă".
   */
  async classifyBeachCategory(product) {
    const imageUrl = product.image || product.images?.[0]?.src || product.images?.[0];
    if (!imageUrl || !config.gemini?.apiKey) return null;

    try {
      const fetch = (await import("node-fetch")).default;
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) return null;

      const imageBuffer = await imageResponse.buffer();
      const base64Image = imageBuffer.toString("base64");
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";

      const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
      const model = genAI.getGenerativeModel({
        model: config.gemini.model,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              category: { type: SchemaType.STRING, description: "One of: slipi de plajă, sutien de plajă, costum de baie, pantaloni de plajă" }
            },
            required: ["category"]
          }
        }
      });

      const demographics = product.detectedDemographics || [];
      const isMan = demographics.includes("man");

      const result = await geminiWithRetry(() => model.generateContent([
        `Look at this beach/swimwear product image. Classify it into exactly ONE of these categories:
- "slipi de plajă" (swim briefs/bikini bottom)
- "sutien de plajă" (bikini top — only when it's a 2-piece set or just the top)
- "costum de baie" (full swimsuit / one-piece / complete 2-piece set)
- "pantaloni de plajă" (beach shorts/trunks${isMan ? " — common for men" : ""})

Product title: "${product.title}"
${isMan ? "This is a MEN's product." : ""}
Return exactly one category.`,
        { inlineData: { mimeType: contentType, data: base64Image } }
      ]));

      const parsed = JSON.parse(result.response.text());
      const category = parsed.category?.toLowerCase()?.trim();
      if (category) {
        console.log(`  [Beach] Classified "${product.title}" → "${category}"`);
        return category;
      }
    } catch (error) {
      console.log(`  [Beach] Classification failed for "${product.title}": ${error.message}`);
    }
    return null;
  }

  /**
   * Hero-image picker: ask Gemini vision which image best represents the actual
   * product mentioned in the title. Returns
   *   { heroImage: <url>, index: <int>, source: "gemini"|"fallback-first"|"only-image"|"no-images", confidence?, reasoning? }
   *
   * Falls back to the first image if confidence is low, the API errors, or the
   * answer is out of bounds. Designed to handle catalogs (like Bronze Snake's)
   * where image[0] is sometimes a lookbook/lifestyle/complementary-product shot
   * rather than the product itself.
   *
   * Uses `runaConfig.gemini.model` (the strong model), not the lite model —
   * vision quality matters more than per-call cost here.
   */
  async pickHeroImage(product) {
    const imageObjs = (product.images || []).filter(Boolean);
    const urls = imageObjs.map(img => img.src || img).filter(Boolean);

    if (urls.length === 0) return { heroImage: null, index: -1, source: "no-images" };
    if (urls.length === 1) return { heroImage: urls[0], index: 0, source: "only-image" };
    if (!config.gemini?.apiKey) return { heroImage: urls[0], index: 0, source: "fallback-first" };

    // Cap the number of images we send (cost + token budget). Beyond ~6, more
    // images give diminishing returns. We always include images 0..5.
    const MAX_IMAGES_PER_CALL = 6;
    const candidateUrls = urls.slice(0, MAX_IMAGES_PER_CALL);

    try {
      const fetch = (await import("node-fetch")).default;

      // Download all candidate images in parallel. Use Shopify's CDN
      // resize hint (?width=512) when possible so we send smaller payloads
      // to Gemini.
      const downloads = await Promise.all(
        candidateUrls.map(async (url) => {
          try {
            const resizedUrl = url.includes("cdn.shopify.com")
              ? url.replace(/\.(jpg|jpeg|png|webp)/i, "_512x.$1")
              : url;
            const r = await fetch(resizedUrl);
            if (!r.ok) {
              const r2 = await fetch(url);
              if (!r2.ok) return null;
              return {
                buffer: Buffer.from(await r2.arrayBuffer()).toString("base64"),
                mime: r2.headers.get("content-type") || "image/jpeg",
              };
            }
            return {
              buffer: Buffer.from(await r.arrayBuffer()).toString("base64"),
              mime: r.headers.get("content-type") || "image/jpeg",
            };
          } catch { return null; }
        })
      );

      const valid = downloads.map((d, i) => ({ d, i })).filter(x => x.d);
      if (valid.length < 2) return { heroImage: urls[0], index: 0, source: "fallback-first" };

      const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
      const model = genAI.getGenerativeModel({
        model: config.gemini.model, // strong model (gemini-3-flash-preview)
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              best_image_index: { type: SchemaType.INTEGER, description: "0-based index of the chosen image among the inputs in the order they were provided." },
              confidence: { type: SchemaType.NUMBER, description: "0.0–1.0 — how sure you are this image best represents the actual product. Low if no image clearly shows the product." },
              reasoning: { type: SchemaType.STRING, description: "One sentence on why this image won." },
            },
            required: ["best_image_index", "confidence", "reasoning"],
          },
        },
      });

      const promptText = [
        `You are picking the THUMBNAIL hero image for a "Complete the Look" / "Similar Products" widget.`,
        `The image will be displayed at SMALL size (~200x200 px).`,
        ``,
        `Product title: "${product.title}"`,
        product.product_type ? `Product type: ${product.product_type}` : "",
        product.vendor ? `Vendor: ${product.vendor}` : "",
        ``,
        `You will receive ${valid.length} candidate images. Pick the SINGLE best one using this STRICT TWO-STEP FILTER:`,
        ``,
        `═══ STEP 1 — REQUIRED: 100% OF THE PRODUCT VISIBLE ═══`,
        ``,
        `First, identify which images show the ENTIRE product (per the title) without ANY part of it being cropped, cut off, or hidden.`,
        ``,
        `Examples of what "100% of product visible" means:`,
        `  • Pants / Trousers / Jeans → ENTIRE leg from waistband to ankle hem must be visible.`,
        `  • Skirts → from waistband to bottom hem must be visible.`,
        `  • Dresses → from neckline/shoulders to bottom hem must be visible.`,
        `  • Tops / Tees / Blouses / Knitwear → from neckline to bottom hem; sleeves visible to cuff.`,
        `  • Jackets / Coats / Bombers / Blazers → from collar to bottom hem; both sleeves visible to cuff.`,
        `  • Shoes / Heels / Sandals / Boots → entire shoe from toe to heel/ankle to top.`,
        `  • Bags / Clutches / Totes → entire bag including handle/strap.`,
        `  • Sunglasses → both lenses + both temples (arms) visible.`,
        `  • Headwear → entire item visible.`,
        `  • Swimwear (bikini top/bottom, one-piece) → entire piece visible (top doesn't have to show the bottom of a 2-piece set; a bikini-top product just needs the top fully visible).`,
        ``,
        `REJECT any image where the product is partially cropped:`,
        `  • Pants where ankles are cut off below the frame → REJECT (product not 100% visible).`,
        `  • Jacket where the bottom hem is below the frame → REJECT.`,
        `  • Bag where the handle is cut off → REJECT.`,
        `  • Extreme detail close-ups of just a buckle, zipper, button, label → REJECT (only a fragment of the product is visible).`,
        ``,
        `── STEP 1 EXCEPTION ──`,
        `If NO image shows 100% of the product (every candidate has some cropping), pick the one with the MOST of the product visible and set confidence below 0.6.`,
        ``,
        `═══ STEP 2 — AMONG THE STEP-1 SURVIVORS, PICK THE TIGHTEST FRAME ═══`,
        ``,
        `From the images that passed Step 1, choose the one where the product takes up the LARGEST proportion of the frame.`,
        ``,
        `  • If a waist-down shot has 100% of pants visible AND a full-body shot also has 100% of pants visible, the waist-down shot wins (product fills more of the frame).`,
        `  • If two shots are nearly equal, prefer the front view over the back view, and the cleaner background.`,
        `  • For shoes/bags/sunglasses/jewelry: prefer clean catalog-on-plain-background shots over lifestyle shots, as long as both have 100% of the product visible.`,
        ``,
        `═══ ALSO REQUIRED ═══`,
        ``,
        `  • The image must clearly show the actual product mentioned in the title (not a complementary/lookbook item from a different product).`,
        `  • Avoid back views unless that's the only option.`,
        ``,
        `═══ CONFIDENCE ═══`,
        ``,
        `  • Confidence ≥ 0.85: at least one image passed Step 1 (full product visible) AND filled the frame well.`,
        `  • Confidence 0.6–0.84: multiple OK options; the chosen one is good but not perfect.`,
        `  • Confidence < 0.6: NO image had 100% of the product visible (we'll fall back to image 0).`,
        ``,
        `Return JSON with: best_image_index (int), confidence (0–1), reasoning (one sentence describing what's 100% visible and why this one fills the frame best).`,
      ].filter(Boolean).join("\n");

      const parts = [
        promptText,
        ...valid.map(({ d }) => ({ inlineData: { mimeType: d.mime, data: d.buffer } })),
      ];

      const result = await geminiWithRetry(() => model.generateContent(parts));
      const parsed = JSON.parse(result.response.text());

      const localIndex = parsed.best_image_index;
      const confidence = parsed.confidence ?? 0;
      const reasoning = parsed.reasoning || "";

      if (typeof localIndex !== "number" || localIndex < 0 || localIndex >= valid.length) {
        console.log(`  [Hero] Out-of-bounds index ${localIndex} for "${product.title}", fallback to 0`);
        return { heroImage: urls[0], index: 0, source: "fallback-first" };
      }
      if (confidence < 0.7) {
        console.log(`  [Hero] Low confidence (${confidence.toFixed(2)}) for "${product.title}", fallback to 0`);
        return { heroImage: urls[0], index: 0, source: "fallback-first", confidence, reasoning };
      }

      // Map valid local index back to the original urls index (skipping failed downloads).
      const originalIndex = valid[localIndex].i;
      console.log(`  [Hero] Picked image[${originalIndex}] for "${product.title}" (conf=${confidence.toFixed(2)}): ${reasoning}`);
      return {
        heroImage: urls[originalIndex],
        index: originalIndex,
        source: "gemini",
        confidence,
        reasoning,
      };
    } catch (error) {
      console.log(`  [Hero] Picker failed for "${product.title}": ${error.message}`);
      return { heroImage: urls[0], index: 0, source: "fallback-first" };
    }
  }

  // ==================== PRODUCT PROCESSING ====================

  async processProducts(products, defaultCategories, shopData) {
    const websiteCategories = defaultCategories || shopifyCategories;

    const concurrency = parseInt(process.env.SYNC_CONCURRENCY, 10) || this.defaultConcurrency || 5;

    const processedProducts = await mapWithConcurrency(products, concurrency, async (product, i, total) => {
      console.log(`\n── Product ${i + 1}/${total}: ${product.title} (${product.id}) ──`);

      if (!product.sku) {
        product.sku = product.vtex?.productReference
          || product.variants?.[0]?.sku
          || null;
      }

      if (product.images && product.images.length > 0) {
        product.image = product.images[0].src || product.images[0];
      } else if (product.image?.src) {
        product.image = product.image.src;
      }

      // ── Phase 1: Run description + properties in PARALLEL ──
      const hasDimensionsOnly = isDimensionsOnly(product.body_html) && isBagProduct(product.title, product.product_type);
      const needsDescription = !product.body_html || product.body_html.trim() === "" || hasDimensionsOnly;
      const descriptionPromise = (needsDescription || this.rewriteDescriptions)
        ? (async () => {
            const imageUrls = (product.images || []).map(img => img.src || img).filter(Boolean);
            const descProduct = {
              title: product.title,
              sku: product.sku,
              vendor: product.vendor,
              image: product.image || imageUrls[0] || null,
              images: imageUrls.length > 0 ? imageUrls.join(",") : null,
              existingDescription: hasDimensionsOnly ? "" : (product.body_html || ""),
              dimensionsText: hasDimensionsOnly ? product.body_html.replace(/<[^>]*>/g, "").trim() : null,
            };
            const aiResult = this.skipGrounding
              ? await rewriteDescriptionFromImage(descProduct, { language: this.descriptionLanguage, geminiModel: this.geminiModel })
              : await generateAIDescription(descProduct, { language: this.descriptionLanguage, geminiModel: this.geminiModel });
            if (aiResult) {
              product.body_html = aiResult.text;
              product.descriptionHtml = aiResult.text;
              product.descriptionSource = aiResult.source;
              console.log(`  [Sync] ✓ Description for "${product.title}" (${aiResult.source})`);
            } else {
              product.descriptionSource = needsDescription ? "none" : "original";
            }
          })()
        : Promise.resolve(() => { product.descriptionSource = "original"; });

      const productContent = `${product.title} ${product.body_html || ""}`;
      const propertiesPromise = (async () => {
        try {
          const propsJson = await this.openai.getProductProperties(productContent, defaultCategories, websiteCategories);
          return JSON.parse(propsJson);
        } catch (e) {
          return { product: "unknown", characteristics: "unknown", color: "unknown", demographic: "woman", category: "Clothing" };
        }
      })();

      const [, productProperties] = await Promise.all([descriptionPromise, propertiesPromise]);

      if (!productProperties.product) productProperties.product = "unknown";
      if (!productProperties.characteristics) productProperties.characteristics = "unknown";
      product.properties = productProperties;

      // ── Phase 1.5: Generate SEO (Title + MetaTagDescription) — Romanian only (TOFF) ──
      if (this.descriptionLanguage === "ro") {
        try {
          const seoInput = {
            title: product.title,
            vendor: product.vendor,
            product_type: product.product_type,
            categories: (product.collections || []).map(c => c.title).filter(Boolean),
            demographics: product.detectedDemographics,
            description: product.body_html || product.descriptionHtml || "",
          };
          const seoResult = await generateSEO(seoInput, { language: this.descriptionLanguage, geminiModel: this.geminiModel });
          if (seoResult) {
            product.seoTitle = seoResult.title;
            product.seoMetaDescription = seoResult.metaDescription;
            product.seoSource = seoResult.source;
            console.log(`  [Sync] ✓ SEO for "${product.title}" (${seoResult.source})`);
          } else {
            product.seoSource = "none";
          }
        } catch (seoErr) {
          console.log(`  [Sync] ✗ SEO generation failed for "${product.title}": ${seoErr.message}`);
          product.seoSource = "error";
        }
      }

      // ── Phase 2: Color, variants, category (fast, no API calls) ──
      const detectedColor = await this.detectColorFromImage(product);
      if (detectedColor) {
        product.detectedColor = detectedColor;
        productProperties.color = detectedColor;
      }

      // Hero image picker — gated to per-shop opt-in (see shouldPickHero).
      // Idempotent: skips products that already have a heroImage unless
      // this.rewriteHeroes is set.
      if (this.shouldPickHero?.(product)) {
        const hero = await this.pickHeroImage(product);
        if (hero?.heroImage) {
          product.heroImage = hero.heroImage;
          product.heroImageIndex = hero.index;
          product.heroImageSource = hero.source;
          product.heroImageDecidedAt = new Date().toISOString();
        }
      }

      product.options = [
        { name: "Color", position: 1 },
        { name: "Size", position: 2 }
      ];

      const colorValue = detectedColor || productProperties.color || "unknown";
      for (const variant of (product.variants || [])) {
        variant.option1 = colorValue;
        variant.option2 = variant.title || "unknown";
        delete variant.option3;
      }

      product.sizes = [...new Set(
        (product.variants || []).map(v => v.option2).filter(s => s && s !== "unknown")
      )];

      const category = this.determineCategory(product, productProperties, websiteCategories);
      product.category = category;

      if (!product.collections || product.collections.length === 0) {
        product.collections = [{ title: category }];
      }

      const isBeach = product.collections.some(c =>
        c.title?.toLowerCase().includes("de plaj")
      ) || category.toLowerCase().includes("de plaj");

      if (isBeach) {
        const beachSubcategory = await this.classifyBeachCategory(product);
        if (beachSubcategory) {
          if (!product.collections.some(c => c.title?.toLowerCase() === beachSubcategory)) {
            product.collections.push({ title: beachSubcategory });
          }
          product.category = beachSubcategory;
        }
      }

      const styleResult = await this.classifyStyle(product);
      product.styleData = styleResult;
      product.styleCode = styleResult 
        ? `${styleResult.body?.join(",")},${styleResult.personality?.join(",")},${styleResult.chromatic?.join(",")}` 
        : "none";

      // ── Phase 3: Embeddings in ONE batch call ──
      const content = `${product.title}. ${product.body_html || ""}`;
      product.content = content;

      const [titleEmb, contentEmb, productEmb, charEmb, catEmb, styleEmb] = await this.openai.generateEmbeddingsBatch([
        product.title, content, productProperties.product,
        productProperties.characteristics, `category: ${category}`, product.styleCode
      ]);

      product.titleEmbedding = titleEmb;
      product.contentEmbedding = contentEmb;
      product.product = productProperties.product;
      product.productEmbedding = productEmb;
      product.characteristics = productProperties.characteristics;
      product.characteristicsEmbedding = charEmb;
      product.categoryEmbedding = catEmb;
      product.styleCodeEmbedding = styleEmb;

      for (const variant of (product.variants || [])) {
        if (variant.price) variant.price = parseFloat(variant.price);
        if (variant.compare_at_price) variant.compare_at_price = parseFloat(variant.compare_at_price);
      }

      product.currency = shopData.currency;
      return product;
    });

    return processedProducts;
  }

  async ensureOptions(product, productProperties) {
    if (!product.options) product.options = [];
    if (!product.variants) product.variants = [];

    const hasSizeOption = product.options.some(o => o.name?.toLowerCase() === "size");
    const hasColorOption = product.options.some(o => o.name?.toLowerCase() === "color");

    if (!hasSizeOption) {
      const pos = product.options.length + 1;
      product.options.push({ name: "Size", position: pos });
      product.variants.forEach(v => { v[`option${pos}`] = "unknown"; });
    }

    if (!hasColorOption) {
      const pos = product.options.length + 1;
      product.options.push({ name: "Color", position: pos });
      product.variants.forEach(v => { v[`option${pos}`] = productProperties.color || "unknown"; });
    }
  }

  async generateOptionEmbeddings(product) {
    const variants = product.variants || [];
    console.log("\n\n\n\n\nvariants", variants);

    const uniqueOptionValues = new Map();
    variants.forEach(variant => {
      product.options.forEach((option, index) => {
        console.log("\n\n\n\n\nvariant", variant);
        console.log("\n\n\n\n\noption", option);
        console.log("\n\n\n\n\n`option${index + 1}`", `option${index + 1}`);
        if (variant[`option${index + 1}`]) {
          const optionValue = String(variant[`option${index + 1}`]).toLowerCase();
          const optionValueForEmbedding = `${option.name.toLowerCase()}: ${optionValue}`;
          if (!uniqueOptionValues.has(optionValueForEmbedding)) {
            uniqueOptionValues.set(optionValueForEmbedding, null);
          }
        }
      });
    });

    // Generate embeddings in parallel
    const embeddingPromises = Array.from(uniqueOptionValues.keys()).map(async key => {
      let embedding = this.openai.getCachedEmbedding(key);
      if (!embedding) {
        try {
          embedding = await this.openai.generateEmbedding(key);
          this.openai.cacheEmbedding(key, embedding);
        } catch (e) {
          console.log(e);
          embedding = null;
        }
      }
      uniqueOptionValues.set(key, embedding);
    });
    await Promise.all(embeddingPromises);

    // Assign embeddings to variants
    variants.forEach((variant, indexVariant) => {
      product.options.forEach((option, index) => {
        if (variant[`option${index + 1}`]) {
          const optionValue = String(variant[`option${index + 1}`]).toLowerCase();
          const optionValueForEmbedding = `${option.name.toLowerCase()}: ${optionValue}`;
          const embedding = uniqueOptionValues.get(optionValueForEmbedding);
          if (embedding) {
            const optionName = option.name.toLowerCase();
            product.variants[indexVariant][`${optionName}Embedding`] = embedding;
            product.variants[indexVariant][`${optionName}Value`] = optionValueForEmbedding;
          }
        }
      });

      // Parse price as float
      if (variant.price) {
        product.variants[indexVariant].price = parseFloat(variant.price);
      }
      if (variant.compare_at_price) {
        product.variants[indexVariant].compare_at_price = parseFloat(variant.compare_at_price);
      }
    });
  }

  determineCategory(product, productProperties, websiteCategories) {
    let category;
    const productTypeCategory = product.product_type ? product.product_type.toLowerCase() : "";
    console.log("\n\ncheck", productTypeCategory);

    if (product.collections && product.collections.length > 0) {
      category = product.collections[0].title;
      console.log("found category from collections");
    } else if (websiteCategories.map(c => c.toLowerCase()).includes(productTypeCategory)) {
      category = productTypeCategory;
      console.log("found category");
    } else {
      console.log("not found category");
      console.log("productProperties.categories", productProperties.category, product.collections);
      category = productProperties.category?.toLowerCase() || "clothing";
    }

    console.log("category match", `initial category: ${product.product_type}`, `final category: ${category}`);
    return category;
  }

  // Override in provider subclass for shop-specific style classification
  async classifyStyle(product) {
    return null;
  }


  async distributeProducts(productsData, storeData, appData, demographicsData) {
    const numConcurrentTransactions = 2;
    const chunkSize = Math.ceil(productsData.length / numConcurrentTransactions);
    const productChunks = [];
    
    for (let i = 0; i < productsData.length; i += chunkSize) {
      productChunks.push(productsData.slice(i, i + chunkSize));
    }

    for (let i = 0; i < productChunks.length; i += numConcurrentTransactions) {
      const batch = productChunks.slice(i, i + numConcurrentTransactions);
      await Promise.all(
        batch.map(async (chunk) => {
          await retryOnDeadlock(() => this.neo4j.saveProducts(chunk, storeData, appData, demographicsData));
          for (const p of chunk) {
            console.log(`  [DB] Saved: ${p.handle || p.id} — "${p.title}"`);
          }
        })
      );
      await delay(200 + Math.floor(Math.random() * 200));
    }
    
    console.log("All products processed with controlled concurrency");
  }

  async processContext() {
    console.log("context fetching");
    let contextFetching = "inProgress";
    this.pubnub.publishContextStatus(this.channelId, contextFetching);
    await this.dynamodb.updateUserContextFetching(this.shopName, this.region, contextFetching);
    console.log("contextFetching", contextFetching);

    // Fetch categories and generate suggestions
    const categories = await this.neo4j.fetchCategories(this.shopName);
    const categoriesList = categories.map(c => c.toLowerCase()).join(", ");
    
    let context = null;
    try {
      const suggestions = await this.openai.generateSuggestions(categoriesList);
      context = { categories: categoriesList, suggestions };
      console.log("suggestions", suggestions);
    } catch (e) {
      console.log("error on generating context");
    }

    if (context) {
      await this.dynamodb.updateUserContext(this.shopName, this.region, context);
    }

    contextFetching = "done";
    this.pubnub.publishContextStatus(this.channelId, contextFetching);
    await this.dynamodb.updateUserContextFetching(this.shopName, this.region, contextFetching);
    console.log("contextFetching", contextFetching);
  }
}

export default BaseProvider;
