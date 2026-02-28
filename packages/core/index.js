/**
 * @runa/core - Main Entry Point
 *
 * Core business logic, database operations, and services.
 */

// Database
export * as neo4j from "./database/neo4j/index.js";
export * as dynamodb from "./database/dynamodb/index.js";
export { neo4jClient } from "./database/neo4j/client.js";
export { dynamoClient } from "./database/dynamodb/client.js";

// Services
export * as ai from "./services/ai/index.js";
export * as storage from "./services/storage/s3.js";
export * as realtime from "./services/realtime/pubnub.js";
export { CostTracker } from "./services/ai/cost-tracker.js";
export { SyncBroadcaster } from "./services/realtime/pubnub.js";

// Sync Pipeline
export { SyncPipeline, createPipeline } from "./sync/pipeline.js";

// Utils
export * as utils from "./utils/index.js";

/**
 * Quick start function to sync a Shopify store
 * @param {Object} options - Sync options
 */
export async function syncShopifyStore(options) {
  const {
    shop,
    token,
    appId = "runa",
    appName = "Runa",
    region = "us-east-1",
    generateEmbeddings = true,
    classifyProducts = true,
    onProgress
  } = options;

  const { ShopifyAdapter } = await import("@runa/adapters");
  const { SyncPipeline } = await import("./sync/pipeline.js");

  const adapter = new ShopifyAdapter(shop, token);
  const pipeline = new SyncPipeline({ appId, appName, region });

  return pipeline.syncStore(adapter, {
    generateEmbeddings,
    classifyProducts,
    onProgress
  });
}

export default {
  syncShopifyStore
};
