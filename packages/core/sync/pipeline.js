import { applications, products as productDb } from "../database/neo4j/index.js";
import { users, logs } from "../database/dynamodb/index.js";
import { embeddings, classifier, CostTracker } from "../services/ai/index.js";
import { SyncBroadcaster } from "../services/realtime/pubnub.js";
import * as s3 from "../services/storage/s3.js";
import { config } from "@runa/config";

/**
 * Sync Pipeline - Orchestrates the product sync process
 */

/**
 * Process a single product through the enrichment pipeline
 * @param {Object} product - Transformed product from adapter
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} - Enriched product
 */
async function processProduct(product, options = {}) {
  const {
    generateEmbeddings = true,
    classifyProducts = true,
    uploadImages = false,
    costTracker
  } = options;

  const enrichedProduct = { ...product };

  // Generate content embedding
  if (generateEmbeddings) {
    const contentText = [
      product.title,
      product.description,
      product.productType,
      product.tags?.join(" ")
    ]
      .filter(Boolean)
      .join(" ");

    enrichedProduct.contentEmbedding = await embeddings.generateEmbedding(contentText);
  }

  // Classify product
  if (classifyProducts) {
    const classification = await classifier.classifyProduct(product);
    enrichedProduct.aiCategories = classification.categories;
    enrichedProduct.primaryCategory = classification.primaryCategory;
    enrichedProduct.demographics = classification.demographics;
    enrichedProduct.characteristics = classification.characteristics;

    // Track costs
    if (costTracker && classification.usage) {
      costTracker.addOpenAIChatCost(classification.usage);
    }

    // Generate characteristics embedding
    if (generateEmbeddings && classification.characteristics) {
      enrichedProduct.characteristicsEmbedding =
        await embeddings.generateProductCharacteristicsEmbedding(
          product,
          classification.characteristics
        );
    }
  }

  // Upload images to S3 (optional)
  if (uploadImages && product.images?.length > 0) {
    enrichedProduct.s3Images = await s3.uploadProductImages(
      product.images,
      product.id
    );
  }

  return enrichedProduct;
}

/**
 * Main sync pipeline class
 */
export class SyncPipeline {
  /**
   * Create a sync pipeline
   * @param {Object} options - { appId, appName, region }
   */
  constructor(options = {}) {
    this.appId = options.appId || "runa";
    this.appName = options.appName || "Runa";
    this.region = options.region || "us-east-1";
    this.costTracker = new CostTracker();
  }

  /**
   * Sync a store using a platform adapter
   * @param {Object} adapter - Platform adapter instance (ShopifyAdapter, etc.)
   * @param {Object} options - Sync options
   * @returns {Promise<Object>} - Sync result
   */
  async syncStore(adapter, options = {}) {
    const {
      generateEmbeddings = true,
      classifyProducts = true,
      uploadImages = false,
      batchSize = config.sync.batchSize,
      onProgress
    } = options;

    const storeInfo = adapter.getStoreInfo();
    const storeId = storeInfo.domain;
    const broadcaster = new SyncBroadcaster(storeId);

    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;
    const errors = [];

    console.log(`\n=== Starting sync for ${storeId} ===`);

    try {
      // Create/update application and store in Neo4j
      await applications.createApplicationAndStore(
        { id: storeId, storeName: storeId },
        { id: this.appId, appName: this.appName }
      );

      // Get product count
      const totalProducts = await adapter.getProductCount();
      console.log(`Total products to sync: ${totalProducts}`);

      // Start broadcast
      broadcaster.setTotal(totalProducts);
      await broadcaster.start();
      await users.updateUserContextFetching(storeId, this.region, "inProgress");

      // Log sync start
      await logs.logSyncStart(storeId, storeInfo.platform, totalProducts);

      // Process products
      const batch = [];

      for await (const product of adapter.getAllProducts()) {
        try {
          // Enrich product
          const enrichedProduct = await processProduct(product, {
            generateEmbeddings,
            classifyProducts,
            uploadImages,
            costTracker: this.costTracker
          });

          // Prepare for Neo4j
          const neo4jProduct = this.prepareForNeo4j(enrichedProduct);
          batch.push(neo4jProduct);

          // Process batch when full
          if (batch.length >= batchSize) {
            await this.saveBatch(storeId, batch);
            batch.length = 0; // Clear batch
          }

          processedCount++;

          // Broadcast progress
          if (processedCount % 10 === 0) {
            await broadcaster.updateProgress(processedCount);
            if (onProgress) {
              onProgress(processedCount, totalProducts);
            }
          }
        } catch (error) {
          console.error(`Error processing product ${product.id}:`, error.message);
          errorCount++;
          errors.push({ productId: product.id, error: error.message });
          await logs.logProductError(storeId, product.id, error);
        }
      }

      // Save remaining batch
      if (batch.length > 0) {
        await this.saveBatch(storeId, batch);
      }

      // Process context (suggestions, etc.)
      console.log("Processing store context...");
      await this.processStoreContext(storeId, adapter);

      // Complete
      const duration = Date.now() - startTime;
      const costSummary = this.costTracker.getSummary();

      await broadcaster.complete({
        totalProcessed: processedCount,
        errors: errorCount,
        duration,
        costs: costSummary.costs
      });

      await users.updateUserContextFetching(storeId, this.region, "done");
      await logs.logSyncComplete(storeId, processedCount, duration, {
        errors: errorCount,
        costs: costSummary.costs
      });

      console.log(`\n=== Sync completed ===`);
      console.log(`Processed: ${processedCount} products`);
      console.log(`Errors: ${errorCount}`);
      console.log(`Duration: ${Math.round(duration / 1000)}s`);
      console.log(`Total cost: $${costSummary.costs.total.toFixed(4)}`);

      return {
        success: true,
        storeId,
        processedCount,
        errorCount,
        errors,
        duration,
        costs: costSummary
      };
    } catch (error) {
      console.error(`Sync failed for ${storeId}:`, error);

      await broadcaster.error(error.message);
      await users.updateUserContextFetching(storeId, this.region, "error");
      await logs.logSyncError(storeId, error);

      return {
        success: false,
        storeId,
        error: error.message,
        processedCount,
        errorCount
      };
    }
  }

  /**
   * Prepare enriched product for Neo4j storage
   * @param {Object} product - Enriched product
   * @returns {Object} - Neo4j-ready product
   */
  prepareForNeo4j(product) {
    return {
      id: product.id,
      title: product.title,
      description: product.description,
      content: product.description, // For compatibility
      handle: product.handle,
      image: product.featuredImage,
      currency: product.currency || "USD",
      contentEmbedding: product.contentEmbedding,
      characteristicsEmbedding: product.characteristicsEmbedding,
      variants: product.variants.map((v) => ({
        id: v.id,
        color: v.color,
        size: v.size,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        sku: v.sku,
        available: v.available
      })),
      categories: product.aiCategories || product.collections || [],
      demographics: product.demographics || []
    };
  }

  /**
   * Save a batch of products to Neo4j
   * @param {string} storeId - Store ID
   * @param {Array} products - Products to save
   */
  async saveBatch(storeId, products) {
    for (const product of products) {
      try {
        await productDb.upsertProduct(storeId, product);
      } catch (error) {
        console.error(`Failed to save product ${product.id}:`, error.message);
      }
    }
  }

  /**
   * Process store context (generate suggestions, etc.)
   * @param {string} storeId - Store ID
   * @param {Object} adapter - Platform adapter
   */
  async processStoreContext(storeId, adapter) {
    try {
      // Get collections for context
      const collections = await adapter.getCollections();

      // Generate store suggestions based on collections
      const suggestions = collections.slice(0, 5).map((c) => ({
        title: c.title,
        query: `Show me ${c.title.toLowerCase()}`
      }));

      // Update user context
      const context = {
        collections: collections.map((c) => c.title),
        suggestions: JSON.stringify({ suggestions }),
        lastSync: new Date().toISOString()
      };

      await users.updateUserContext(storeId, this.region, context);
    } catch (error) {
      console.error("Failed to process store context:", error.message);
    }
  }

  /**
   * Get cost summary
   */
  getCostSummary() {
    return this.costTracker.getSummary();
  }

  /**
   * Reset cost tracker
   */
  resetCostTracker() {
    this.costTracker.reset();
  }
}

/**
 * Create a sync pipeline instance
 * @param {Object} options - Pipeline options
 * @returns {SyncPipeline}
 */
export function createPipeline(options) {
  return new SyncPipeline(options);
}

export default SyncPipeline;
