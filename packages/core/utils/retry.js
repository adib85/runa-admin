/**
 * Retry utilities for handling transient failures
 */

/**
 * Delay execution for specified milliseconds
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<any>} - Result of successful execution
 */
export async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    shouldRetry = () => true,
    onRetry = () => {}
  } = options;

  let lastError;
  let currentDelay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error, attempt)) {
        throw error;
      }

      onRetry(error, attempt, currentDelay);

      await delay(currentDelay);
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Retry with specific handling for rate limits
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Options
 * @returns {Promise<any>}
 */
export async function retryWithRateLimit(fn, options = {}) {
  return retry(fn, {
    ...options,
    shouldRetry: (error) => {
      // Retry on rate limit errors
      if (error.status === 429) return true;
      if (error.message?.includes("rate limit")) return true;
      if (error.message?.includes("throttl")) return true;

      // Check for custom shouldRetry
      if (options.shouldRetry) {
        return options.shouldRetry(error);
      }

      // Don't retry other errors by default
      return false;
    },
    onRetry: (error, attempt, delayMs) => {
      console.log(`Rate limited, retrying in ${delayMs}ms (attempt ${attempt})...`);
      if (options.onRetry) {
        options.onRetry(error, attempt, delayMs);
      }
    }
  });
}

/**
 * Process items in batches with controlled concurrency
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each item
 * @param {Object} options - { batchSize, concurrency }
 * @returns {Promise<Array>} - Results
 */
export async function processBatches(items, processor, options = {}) {
  const { batchSize = 10, concurrency = 5 } = options;
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    // Process batch with concurrency limit
    const batchResults = await processWithConcurrency(batch, processor, concurrency);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Process items with limited concurrency
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each item
 * @param {number} concurrency - Max concurrent operations
 * @returns {Promise<Array>} - Results
 */
export async function processWithConcurrency(items, processor, concurrency = 5) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      try {
        results[index] = await processor(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

export default {
  delay,
  retry,
  retryWithRateLimit,
  processBatches,
  processWithConcurrency
};
