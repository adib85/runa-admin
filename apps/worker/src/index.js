/**
 * RUNA Admin Worker
 *
 * Background job processor for long-running tasks like product sync.
 * In production, this would connect to Redis/BullMQ for job queue.
 * For now, it provides a simple in-memory queue for development.
 */

import { config } from "@runa/config";
import { SyncPipeline, dynamodb, neo4jClient } from "@runa/core";
import { ShopifyAdapter } from "@runa/adapters";

// Simple in-memory job queue for development
// In production, replace with Redis/BullMQ
class JobQueue {
  constructor() {
    this.jobs = new Map();
    this.processing = false;
  }

  async add(job) {
    this.jobs.set(job.id, {
      ...job,
      status: "queued",
      createdAt: new Date().toISOString()
    });
    console.log(`Job ${job.id} added to queue`);
    this.processNext();
    return job.id;
  }

  async processNext() {
    if (this.processing) return;

    // Find next queued job
    const queuedJob = Array.from(this.jobs.values())
      .find(j => j.status === "queued");

    if (!queuedJob) return;

    this.processing = true;
    queuedJob.status = "processing";
    queuedJob.startedAt = new Date().toISOString();

    console.log(`Processing job ${queuedJob.id}...`);

    try {
      await this.executeJob(queuedJob);
      queuedJob.status = "completed";
      queuedJob.completedAt = new Date().toISOString();
      console.log(`Job ${queuedJob.id} completed`);
    } catch (error) {
      queuedJob.status = "failed";
      queuedJob.error = error.message;
      queuedJob.failedAt = new Date().toISOString();
      console.error(`Job ${queuedJob.id} failed:`, error.message);
    }

    this.processing = false;
    this.processNext(); // Process next job
  }

  async executeJob(job) {
    switch (job.type) {
      case "sync":
        return this.executeSyncJob(job);
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  async executeSyncJob(job) {
    const { storeDomain, accessToken, platform, options = {} } = job.data;

    // Create adapter
    let adapter;
    switch (platform) {
      case "shopify":
        adapter = new ShopifyAdapter(storeDomain, accessToken);
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }

    // Create pipeline
    const pipeline = new SyncPipeline({
      appId: options.appId || "runa",
      appName: options.appName || "Runa",
      region: options.region || "us-east-1"
    });

    // Run sync
    const result = await pipeline.syncStore(adapter, {
      generateEmbeddings: options.generateEmbeddings !== false,
      classifyProducts: options.classifyProducts !== false,
      onProgress: (processed, total) => {
        job.progress = { processed, total };
      }
    });

    job.result = result;
    return result;
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  getStats() {
    const jobs = Array.from(this.jobs.values());
    return {
      total: jobs.length,
      queued: jobs.filter(j => j.status === "queued").length,
      processing: jobs.filter(j => j.status === "processing").length,
      completed: jobs.filter(j => j.status === "completed").length,
      failed: jobs.filter(j => j.status === "failed").length
    };
  }
}

// Create queue instance
const queue = new JobQueue();

// Simple HTTP server for job management (optional)
import { createServer } from "http";

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  // Health check
  if (url.pathname === "/health") {
    res.end(JSON.stringify({ status: "ok", stats: queue.getStats() }));
    return;
  }

  // Add job
  if (req.method === "POST" && url.pathname === "/jobs") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const job = JSON.parse(body);
        const jobId = await queue.add({
          id: `job_${Date.now()}`,
          ...job
        });
        res.statusCode = 201;
        res.end(JSON.stringify({ jobId }));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // Get job status
  if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const jobId = url.pathname.replace("/jobs/", "");
    const job = queue.getJob(jobId);
    if (job) {
      res.end(JSON.stringify(job));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Job not found" }));
    }
    return;
  }

  // Not found
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
});

const WORKER_PORT = process.env.WORKER_PORT || 3002;

server.listen(WORKER_PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  RUNA ADMIN WORKER                        ║
╠═══════════════════════════════════════════════════════════╣
║  Worker running on http://localhost:${WORKER_PORT}                ║
║  Environment: ${config.server.env.padEnd(40)}║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /health     - Health check & stats                ║
║    POST /jobs       - Add a job                           ║
║    GET  /jobs/:id   - Get job status                      ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down worker...");
  server.close();
  await neo4jClient.close();
  process.exit(0);
});

export { queue };
