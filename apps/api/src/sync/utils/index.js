/**
 * Utils Index
 */

export { shopifyCategories } from "./categories.js";
export { convertHtmlToMarkdown, stripHtmlTags } from "./html.js";

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retryOnDeadlock(operation, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'Neo.TransientError.Transaction.DeadlockDetected' && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 300);
        console.log(`Deadlock detected, retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})`);
        await delay(backoffMs);
        continue;
      }
      throw error;
    }
  }
}

export function extractRelevantFields(product) {
  return {
    title: product.title,
    description: product.body_html,
    product_type: product.product_type,
    tags: product.tags,
    vendor: product.vendor
  };
}

// ─── Concurrency pool ────────────────────────────────────────────────

export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i, items.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ─── Gemini Rate Limiter (sliding window) ────────────────────────────

class GeminiRateLimiter {
  constructor(maxRPM = 10) {
    this.maxRPM = maxRPM;
    this.timestamps = [];
  }

  async acquire() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);

    if (this.timestamps.length >= this.maxRPM) {
      const waitMs = 60_000 - (now - this.timestamps[0]) + 500;
      console.log(`  [Rate Limit] Gemini RPM limit (${this.maxRPM}) reached, waiting ${(waitMs / 1000).toFixed(1)}s...`);
      await delay(waitMs);
      return this.acquire();
    }

    this.timestamps.push(Date.now());
  }
}

export const geminiLimiter = new GeminiRateLimiter(
  parseInt(process.env.GEMINI_MAX_RPM, 10) || 10
);

function isRateLimitError(error) {
  const msg = error?.message || "";
  return error?.status === 429
    || msg.includes("429")
    || msg.includes("RESOURCE_EXHAUSTED")
    || msg.includes("rate")
    || msg.includes("quota");
}

export async function geminiWithRetry(fn, maxRetries = 6) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await geminiLimiter.acquire();
    try {
      return await fn();
    } catch (error) {
      if (isRateLimitError(error) && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000);
        console.log(`  [Rate Limit] 429 on attempt ${attempt}/${maxRetries}, retrying in ${(backoffMs / 1000).toFixed(1)}s...`);
        await delay(backoffMs);
        continue;
      }
      throw error;
    }
  }
}
