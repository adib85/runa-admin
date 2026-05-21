import { Router } from "express";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { dynamodb } from "@runa/core";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/error.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNC_MODULAR_SCRIPT = path.resolve(__dirname, "../scripts/sync-modular.js");

const router = Router();

// All routes require authentication
router.use(authenticate);

// In-memory job queue (for development - use Redis/BullMQ in production)
const jobQueue = new Map();
// Separate queue for modular sync jobs (subprocesses) — keyed by shop domain
const modularJobs = new Map();

/**
 * Resolve the "store" the request refers to from the user row. With shop-as-id
 * each user has exactly one store (their own row), so storeId is just a
 * routing param. We accept it matching `user.id`, `user.shop`, or the public
 * website domain.
 */
function resolveStore(user, storeId) {
  if (!user) return null;
  const matches =
    storeId === user.id || storeId === user.shop || storeId === user.domain;
  if (!matches) return null;
  return {
    id: user.id,
    platform: (user.platform || "shopify").toLowerCase(),
    domain: user.domain || user.shop,
    shop: user.shop,
    accessToken: user.accessToken || null,
    status: user.status || null,
    productsCount: user.productsCount ?? user.totalProducts ?? 0,
    lastSync: user.lastSync || user.syncStatus?.lastUpdated || null
  };
}

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

  const store = resolveStore(user, storeId);
  if (!store) {
    throw ApiError.notFound("Store not found");
  }

  // Shopify: accessToken at the user root. VTEX: vtexApiKey/vtexToken at root.
  let accessToken = store.accessToken;
  if (store.platform === "shopify" && user.accessToken) {
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

  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = resolveStore(user, storeId);
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

  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = resolveStore(user, storeId);
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

  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = resolveStore(user, storeId);
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

    // Update store's lastSync on the user row (top-level fields).
    const user = await dynamodb.users.getUserById(job.userId);
    if (user) {
      user.lastSync = new Date().toISOString();
      user.productsCount = result.processedCount;
      user.status = result.success ? "active" : "error";
      user.updatedAt = user.lastSync;
      await dynamodb.users.saveUser(user);
      console.log(`Updated store sync status for user ${user.id}`);
    }

    return result;
  } catch (error) {
    console.error(`\n=== Sync job ${job.id} failed ===`);
    console.error("Error:", error.message);

    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();

    // Update store status to error (top-level fields).
    try {
      const user = await dynamodb.users.getUserById(job.userId);
      if (user) {
        user.status = "error";
        user.lastError = error.message;
        user.updatedAt = new Date().toISOString();
        await dynamodb.users.saveUser(user);
      }
    } catch (updateError) {
      console.error("Failed to update store error status:", updateError.message);
    }

    throw error;
  }
}

// ════════════════════════════════════════════════════════════════════
// MODULAR sync endpoints — run apps/api/src/scripts/sync-modular.js
// as a child process and track progress. Uses the latest provider logic
// (e.g. Bronze Snake's storefront-visibility filter, demographic detection,
// style-filter category enrichment). Independent of /api/sync/start which
// uses the older @runa/core SyncPipeline.
// ════════════════════════════════════════════════════════════════════

function safeShop(shop) {
  return /^[a-z0-9-]+\.(myshopify\.com|vtexcommercestable\.com\.br)$/i.test(shop || "");
}

/**
 * POST /api/sync/modular/start
 * Body: { storeId, since?, force?, max?, rewriteDescriptions?, geminiModel? }
 * Spawns sync-modular.js in a child process. Idempotent — refuses to start
 * if a sync is already running for this shop.
 */
router.post("/modular/start", asyncHandler(async (req, res) => {
  const { storeId, since, force, max, rewriteDescriptions, geminiModel } = req.body || {};

  if (!storeId) throw ApiError.badRequest("storeId is required");

  const user = await dynamodb.users.getUserById(req.user.userId);
  if (!user) throw ApiError.notFound("User not found");

  const store = resolveStore(user, storeId);
  if (!store) throw ApiError.notFound("Store not found");

  const shop = (user.shop || store.domain || "").toLowerCase();
  if (!safeShop(shop)) throw ApiError.badRequest(`Invalid or unsupported shop: ${shop}`);

  let accessToken = store.accessToken || user.accessToken;
  if (!accessToken) throw ApiError.badRequest("No access token configured for this store");

  const provider = (store.platform || user.platform || "shopify").toLowerCase();

  const existing = modularJobs.get(shop);
  if (existing && existing.status === "running") {
    return res.json({
      message: "Modular sync already in progress",
      jobId: existing.id,
      status: existing.status,
      progress: existing.progress,
      total: existing.total,
      log: existing.log.slice(-30),
    });
  }

  const jobId = `mod_${shop.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;
  const startedAt = new Date().toISOString();

  // Build CLI args for sync-modular.js
  const args = [SYNC_MODULAR_SCRIPT, provider, shop, accessToken];
  if (force) args.push("--force");
  if (rewriteDescriptions) args.push("--rewrite-descriptions");
  if (max && Number.isFinite(+max)) args.push("--max", String(+max));
  if (since && /^\d+[smhd]$/.test(since)) args.push("--since", since);
  if (geminiModel) args.push("--gemini-model", geminiModel);

  const job = {
    id: jobId,
    shop,
    storeId,
    status: "running",
    progress: 0,
    total: 0,
    startedAt,
    completedAt: null,
    error: null,
    log: [],
    args: args.slice(1).filter(a => a !== accessToken),  // hide token in args echo
  };
  modularJobs.set(shop, job);

  console.log(`[sync/modular] spawning: node ${args.join(" ").replace(accessToken, "***")}`);
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, "../../../.."),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = child.pid;

  // Stream stdout/stderr — keep last 200 lines, parse known progress markers.
  const handleLine = (line) => {
    job.log.push(line);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);

    // Progress: "  Progress: 240/3401 (7.1%)" or "✓ Finalized: N products"
    const progressM = line.match(/Progress:\s*(\d+)\s*\/\s*(\d+)/);
    if (progressM) {
      job.progress = parseInt(progressM[1], 10);
      job.total = parseInt(progressM[2], 10);
    }
    const newM = line.match(/Existing:\s*(\d+),\s*New:\s*(\d+)/);
    if (newM) job.lastBatch = { existing: +newM[1], new: +newM[2] };
  };

  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const parts = stdoutBuf.split("\n");
    stdoutBuf = parts.pop();
    parts.forEach(handleLine);
  });
  child.stderr.on("data", (chunk) => {
    chunk.toString().split("\n").filter(Boolean).forEach(l => job.log.push("[stderr] " + l));
  });

  child.on("close", (code) => {
    if (stdoutBuf) handleLine(stdoutBuf);
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.completedAt = new Date().toISOString();
    if (code !== 0) job.error = `Exited with code ${code}`;
    console.log(`[sync/modular] ${job.id} ${job.status} (exit ${code})`);
  });

  child.on("error", (err) => {
    job.status = "failed";
    job.error = err.message;
    job.completedAt = new Date().toISOString();
  });

  res.json({
    message: "Modular sync started",
    jobId,
    status: "running",
    channelId: `${shop}_scan`,
    args: job.args,
  });
}));

/**
 * GET /api/sync/modular/status/:storeId
 * Returns current job state for a shop (idle if no run in memory).
 */
router.get("/modular/status/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = resolveStore(user, storeId);
  if (!store) throw ApiError.notFound("Store not found");

  const shop = (user.shop || store.domain || "").toLowerCase();
  const job = modularJobs.get(shop);

  if (!job) {
    return res.json({ status: "idle", lastSync: store.lastSync || null });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    total: job.total,
    lastBatch: job.lastBatch || null,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode ?? null,
    error: job.error,
    pid: job.pid,
    args: job.args,
    recentLog: job.log.slice(-30),
  });
}));

/**
 * POST /api/sync/modular/cancel/:storeId
 * Sends SIGTERM to the running modular sync subprocess (if any).
 */
router.post("/modular/cancel/:storeId", asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const user = await dynamodb.users.getUserById(req.user.userId);
  const store = resolveStore(user, storeId);
  if (!store) throw ApiError.notFound("Store not found");

  const shop = (user.shop || store.domain || "").toLowerCase();
  const job = modularJobs.get(shop);
  if (!job || job.status !== "running" || !job.pid) {
    return res.json({ message: "No running modular sync to cancel" });
  }

  try {
    process.kill(job.pid, "SIGTERM");
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    res.json({ message: "Cancellation signal sent", jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

export default router;
