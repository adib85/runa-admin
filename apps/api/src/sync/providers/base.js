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
import { generateAIDescription } from "../services/ai-product-description.js";

export class BaseProvider {
  constructor(config) {
    this.shopName = config.shopName;
    this.accessToken = config.accessToken;
    this.channelId = config.channelId || `${config.shopName}_scan`;
    this.region = config.region || "us-east-1";
    this.forceAll = config.forceAll || false;
    
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
    console.log(`\n=== Starting ${this.providerType} Sync for ${this.shopName} ===\n`);
    
    const appData = { id: "runa", appName: "Runa" };
    const storeData = { id: this.shopName, storeName: this.shopName };

    // Create application and store
    await this.neo4j.createApplicationAndStore(storeData, appData);

    // Sync products
    await this.syncProducts();

    // Process context
    await this.processContext();

    console.log(`\n=== ${this.providerType} Sync Complete for ${this.shopName} ===\n`);
  }

  async syncProducts() {
    console.log("saving products started 1");
    console.log("shopName, region", this.shopName, this.region);

    const user = await this.dynamodb.getUserByShop(this.shopName, this.region);
    console.log("user", user);

    if (user) {
      user.syncInProgress = true;
      user.syncProgress = 0;
      await this.dynamodb.saveUser(user, this.region);
    }

    // Fetch collections
    const collections = await this.fetchCollections();
    console.log("allCategories", collections);
    if (collections && collections.length > 0) {
      await this.neo4j.createOrUpdateCategories(collections);
    }

    // Fetch and process products
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
    const demographicsData = ["woman"];
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

    while (hasMore) {
      // Fetch batch of products
      const { products, nextCursor, hasNextPage } = await this.fetchProducts({ cursor, limit: 20 });
      hasMore = hasNextPage;
      cursor = nextCursor;

      totalProductsSeen += products.length;
      if (!count) count = totalProductsSeen + (hasMore ? 200 : 0);

      console.log(`\n=== Batch: ${products.length} products, Total: ${totalProductsSeen} ===`);

      if (products.length === 0) continue;

      // Filter existing products (unless force mode)
      let productsToProcess = products;
      if (!this.forceAll) {
        const existingIds = await this.neo4j.getExistingProductIds(
          this.shopName,
          products.map(p => p.id)
        );
        const existingProducts = products.filter(p => existingIds.has(String(p.id)));
        productsToProcess = products.filter(p => !existingIds.has(String(p.id)));
        console.log(`  Existing: ${existingProducts.length}, New: ${productsToProcess.length}`);
      } else {
        console.log(`  Force mode: processing all ${productsToProcess.length} products`);
      }

      // Process products
      if (productsToProcess.length > 0) {
        const processedProducts = await this.processProducts(productsToProcess, defaultCategories, shopData);
        await this.distributeProducts(processedProducts, storeData, appData, demographicsData);
        countProcessed += productsToProcess.length;
        if (countProcessed > count) countProcessed = count;

        console.log(`  Progress: ${totalProductsSeen}/${count} (${((totalProductsSeen / count) * 100).toFixed(1)}%)`);
        this.pubnub.publishProgress(this.channelId, countProcessed, count);
        await this.dynamodb.updateSyncProgress(this.shopName, countProcessed !== count, countProcessed, count, this.region);
      }

      // Save progress after each batch for resume capability
      this.saveProgress({
        startedAt: syncStartedAt,
        countProcessed,
        totalProductsSeen,
        count,
        providerState: this.getCursorState ? this.getCursorState() : null
      });
    }

    // Sync complete — clean up progress file
    this.clearProgress();

    // Finalize
    this.pubnub.publishProgress(this.channelId, countProcessed, count);
    await this.dynamodb.updateSyncProgress(this.shopName, false, countProcessed, count, this.region);
    console.log(`\n✓ Finalized: ${countProcessed} products`);
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

  // ==================== PRODUCT PROCESSING ====================

  async processProducts(products, defaultCategories, shopData) {
    const websiteCategories = defaultCategories || shopifyCategories;

    const concurrency = parseInt(process.env.SYNC_CONCURRENCY, 10) || 5;

    const processedProducts = await mapWithConcurrency(products, concurrency, async (product, i, total) => {
      console.log(`\n── Product ${i + 1}/${total} ──`);
      console.log("productItem - ", product.id, " -- ", product.product_type, " -- ", product.title);
      console.log("productItem initial", product);

      if (!product.sku) {
        product.sku = product.vtex?.productReference || null;
        if (product.sku) console.log(`  [Sync] SKU set: ${product.sku}`);
      }

      if (!product.body_html || product.body_html.trim() === "") {
        console.log(`  [Sync] Product "${product.title}" has no description, generating with AI...`);

        const imageUrls = (product.images || []).map(img => img.src || img).filter(Boolean);
        const descProduct = {
          title: product.title,
          sku: product.sku,
          vendor: product.vendor,
          image: product.image?.src || product.image || imageUrls[0] || null,
          images: imageUrls.length > 0 ? imageUrls.join(",") : null,
        };
        console.log(`  [Sync] Description product:`, JSON.stringify(descProduct, null, 2));

        const aiResult = await generateAIDescription(descProduct);
        if (aiResult) {
          product.body_html = aiResult.text;
          product.descriptionHtml = aiResult.text;
          product.descriptionSource = aiResult.source;
          console.log(`  [Sync] ✓ AI description set for "${product.title}" (source: ${aiResult.source})`);
        } else {
          product.descriptionSource = "none";
          console.log(`  [Sync] ✗ Could not generate description for "${product.title}", continuing without it`);
        }
      } else {
        product.descriptionSource = "original";
      }

      const productContent = `${product.title} ${product.body_html || ""}`;
      console.log("defaultCategories in products", defaultCategories);
      
      let productProperties;
      try {
        const propsJson = await this.openai.getProductProperties(productContent, defaultCategories, websiteCategories);
        productProperties = JSON.parse(propsJson);
      } catch (e) {
        console.log(e);
        productProperties = { product: "unknown", characteristics: "unknown", color: "unknown", demographic: "woman", category: "Clothing" };
      }

      if (!productProperties.product) {
        console.log("error on properties", productProperties);
        productProperties.product = "unknown";
      }
      if (!productProperties.characteristics) {
        console.log("error on properties", productProperties);
        productProperties.characteristics = "unknown";
      }

      product.properties = productProperties;

      if (product.images && product.images.length > 0) {
        product.image = product.images[0].src || product.images[0];
      } else if (product.image?.src) {
        product.image = product.image.src;
      }

      const detectedColor = await this.detectColorFromImage(product);
      if (detectedColor) {
        product.detectedColor = detectedColor;
        productProperties.color = detectedColor;
      }

      product.options = [
        { name: "Color", position: 1 },
        { name: "Size", position: 2 }
      ];

      const colorValue = detectedColor || productProperties.color || "unknown";
      for (const variant of (product.variants || [])) {
        const size = variant.title || "unknown";
        variant.option1 = colorValue;
        variant.option2 = size;
        delete variant.option3;
      }

      const sizes = [...new Set(
        (product.variants || [])
          .map(v => v.option2)
          .filter(Boolean)
          .filter(s => s !== "unknown")
      )];
      product.sizes = sizes;

      await this.generateOptionEmbeddings(product);

      const category = this.determineCategory(product, productProperties, websiteCategories);
      product.category = category;
      console.log("category", category);

      if (!product.collections || product.collections.length === 0) {
        product.collections = [{ title: category }];
      }

      const isBeach = product.collections.some(c =>
        c.title?.toLowerCase().includes("de plaj")
      ) || category.toLowerCase().includes("de plaj");

      if (isBeach) {
        const beachSubcategory = await this.classifyBeachCategory(product);
        if (beachSubcategory) {
          const alreadyHas = product.collections.some(c =>
            c.title?.toLowerCase() === beachSubcategory
          );
          if (!alreadyHas) {
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

      const content = `${product.title}. ${product.body_html || ""}`;
      product.content = content;

      const [titleEmb, contentEmb, productEmb, charEmb, catEmb, styleEmb] = await Promise.all([
        this.openai.generateEmbedding(product.title),
        this.openai.generateEmbedding(content),
        this.openai.generateEmbedding(productProperties.product),
        this.openai.generateEmbedding(productProperties.characteristics),
        this.openai.generateEmbedding(`category: ${category}`),
        this.openai.generateEmbedding(product.styleCode)
      ]);

      product.titleEmbedding = titleEmb;
      product.contentEmbedding = contentEmb;
      product.product = productProperties.product;
      product.productEmbedding = productEmb;
      product.characteristics = productProperties.characteristics;
      product.characteristicsEmbedding = charEmb;
      product.categoryEmbedding = catEmb;
      product.styleCodeEmbedding = styleEmb;
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
