import { Router } from "express";
import { dynamodb } from "@runa/core";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";

const router = Router();

// All routes require authentication
router.use(authenticate);

// In-memory job queue (for development - use Redis/BullMQ in production)
const jobQueue = new Map();

/**
 * POST /api/sync/start
 * Start a sync job for a store
 */
router.post("/start", asyncHandler(async (req, res) => {
  const { storeId } = req.body;

  if (!storeId) {
    throw ApiError.badRequest("storeId is required");
  }

  // Get user from database
  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  // Verify user owns this store
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  // Get accessToken from user record based on platform
  // For Shopify: accessToken is at user root level
  // For VTEX: vtexApiKey and vtexToken at user root level
  let accessToken = store.accessToken;
  if (store.platform?.toLowerCase() === 'shopify' && user.accessToken) {
    accessToken = user.accessToken;
  }

  if (!accessToken) {
    throw ApiError.badRequest("Store access token not configured. Please update your store credentials.");
  }

  // Check if sync is already running
  const existingJob = jobQueue.get(storeId);
  if (existingJob && existingJob.status === "running") {
    return res.json({
      message: "Sync already in progress",
      jobId: existingJob.id,
      status: existingJob.status,
      progress: existingJob.progress,
      total: existingJob.total
    });
  }

  // Use shop from user record if available (for Lambda API compatibility)
  const shopDomain = user.shop || store.domain;

  // Create job
  const jobId = `sync_${storeId}_${Date.now()}`;
  const job = {
    id: jobId,
    storeId,
    storeDomain: shopDomain,
    platform: store.platform || user.platform,
    accessToken,
    status: "queued",
    progress: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    userId: req.user.userId,
    region: "us-east-1"
  };

  jobQueue.set(storeId, job);

  // Start sync in background (fire and forget)
  // In production, this would add to Redis/BullMQ queue
  startSyncJob(job).catch(err => {
    console.error(`Sync job ${jobId} failed:`, err);
    job.status = "failed";
    job.error = err.message;
    job.completedAt = new Date().toISOString();
  });

  res.json({
    message: "Sync job started",
    jobId,
    status: "queued",
    channelId: `${shopDomain}_scan` // PubNub channel for real-time updates
  });
}));

/**
 * GET /api/sync/status/:storeId
 * Get sync status for a store
 */
router.get("/status/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  const job = jobQueue.get(storeId);

  if (!job) {
    return res.json({
      status: "idle",
      lastSync: store.lastSync
    });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    total: job.total,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error
  });
}));

/**
 * POST /api/sync/cancel/:storeId
 * Cancel a running sync job
 */
router.post("/cancel/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  const job = jobQueue.get(storeId);

  if (!job || job.status !== "running") {
    return res.json({ message: "No running sync job to cancel" });
  }

  job.status = "cancelled";
  job.cancelledAt = new Date().toISOString();

  res.json({ message: "Sync job cancelled" });
}));

/**
 * GET /api/sync/history/:storeId
 * Get sync history for a store
 */
router.get("/history/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const { limit = 10 } = req.query;

  // Verify user owns this store
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = (user?.stores || []).find(s => s.id === storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  // Get logs from DynamoDB
  const logs = await dynamodb.logs.getLogsByStore(store.domain, {
    limit: parseInt(limit),
    types: ["sync_start", "sync_complete", "sync_error"]
  });

  res.json({ history: logs });
}));

/**
 * Background sync job runner
 * In production, this would be in the worker app
 */
async function startSyncJob(job) {
  console.log(`\n=== Starting sync job ${job.id} for ${job.storeDomain} ===\n`);

  job.status = "running";

  try {
    // Import the adapters and core dynamically
    const { ShopifyAdapter } = await import("@runa/adapters");
    const { SyncPipeline } = await import("@runa/core");

    // Create adapter based on platform
    let adapter;
    const platform = (job.platform || "shopify").toLowerCase();

    switch (platform) {
      case "shopify":
        console.log(`Creating Shopify adapter for ${job.storeDomain}`);
        adapter = new ShopifyAdapter(job.storeDomain, job.accessToken);
        break;
      default:
        throw new Error(`Unsupported platform: ${job.platform}. Currently only Shopify is supported.`);
    }

    // Get total count
    console.log("Getting product count...");
    try {
      job.total = await adapter.getProductCount();
      console.log(`Total products to sync: ${job.total}`);
    } catch (countError) {
      console.error("Failed to get product count:", countError.message);
      job.total = 0;
    }

    // Create pipeline
    const pipeline = new SyncPipeline({
      appId: "runa",
      appName: "Runa",
      region: job.region || "us-east-1"
    });

    // Run sync with progress callback
    console.log("Starting sync pipeline...");
    const result = await pipeline.syncStore(adapter, {
      generateEmbeddings: true,
      classifyProducts: true,
      onProgress: (processed, total) => {
        job.progress = processed;
        job.total = total;
        if (processed % 10 === 0) {
          console.log(`Sync progress: ${processed}/${total} products`);
        }
      }
    });

    // Update job status
    job.status = result.success ? "completed" : "failed";
    job.completedAt = new Date().toISOString();
    job.result = {
      processedCount: result.processedCount,
      errorCount: result.errorCount,
      duration: result.duration,
      costs: result.costs
    };

    console.log(`\n=== Sync job ${job.id} completed ===`);
    console.log(`Processed: ${result.processedCount} products`);
    console.log(`Errors: ${result.errorCount}`);
    console.log(`Duration: ${Math.round((result.duration || 0) / 1000)}s`);

    // Update store's lastSync in user data
    const user = await dynamodb.users.getUserById(job.userId);
    if (user) {
      // Find store by either domain or id
      const storeIndex = (user.stores || []).findIndex(s => 
        s.domain === job.storeDomain || s.id === job.storeId
      );
      
      if (storeIndex !== -1) {
        user.stores[storeIndex].lastSync = new Date().toISOString();
        user.stores[storeIndex].productsCount = result.processedCount;
        user.stores[storeIndex].status = result.success ? "active" : "error";
        await dynamodb.users.saveUser(user);
        console.log(`Updated store sync status for user ${user.id}`);
      }
    }

    return result;
  } catch (error) {
    console.error(`\n=== Sync job ${job.id} failed ===`);
    console.error("Error:", error.message);

    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();

    // Update store status to error
    try {
      const user = await dynamodb.users.getUserById(job.userId);
      if (user) {
        const storeIndex = (user.stores || []).findIndex(s => 
          s.domain === job.storeDomain || s.id === job.storeId
        );
        if (storeIndex !== -1) {
          user.stores[storeIndex].status = "error";
          user.stores[storeIndex].lastError = error.message;
          await dynamodb.users.saveUser(user);
        }
      }
    } catch (updateError) {
      console.error("Failed to update store error status:", updateError.message);
    }

    throw error;
  }
}

export default router;
