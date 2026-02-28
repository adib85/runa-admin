/**
 * Pricing models for AI services - used for cost tracking
 */
export const PRICING = {
  openai: {
    "gpt-4o-mini": {
      inputPerTokenUSD: 0.15 / 1e6,
      cachedInputPerTokenUSD: 0.025 / 1e6,
      outputPerTokenUSD: 0.60 / 1e6
    },
    "text-embedding-3-small": {
      inputPerTokenUSD: 0.02 / 1e6
    }
  },
  gemini: {
    "gemini-2.5-flash-preview-09-2025": {
      inputPerTokenUSD: 0.10 / 1e6,
      outputPerTokenUSD: 0.40 / 1e6,
      cachedInputPerTokenUSD: 0.025 / 1e6
    }
  }
};

/**
 * Default Shopify product categories for classification
 */
export const SHOPIFY_CATEGORIES = [
  "Accessories",
  "Bags",
  "Clothing",
  "Dresses",
  "Footwear",
  "Jackets & Coats",
  "Jewelry",
  "Pants",
  "Shirts & Tops",
  "Shorts",
  "Skirts",
  "Sleepwear",
  "Sportswear",
  "Suits",
  "Sweaters",
  "Swimwear",
  "Underwear"
];

/**
 * Platform types supported by the system
 */
export const PLATFORMS = {
  SHOPIFY: "shopify",
  WOOCOMMERCE: "woocommerce",
  VTEX: "vtex",
  CUSTOM: "custom"
};

/**
 * Sync job statuses
 */
export const SYNC_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "inProgress",
  COMPLETED: "completed",
  FAILED: "failed"
};

/**
 * Rate limits
 */
export const RATE_LIMITS = {
  shopify: {
    requestsPerSecond: 2,
    maxRetries: 3
  },
  openai: {
    requestsPerMinute: 500,
    tokensPerMinute: 200000
  }
};

export default {
  PRICING,
  SHOPIFY_CATEGORIES,
  PLATFORMS,
  SYNC_STATUS,
  RATE_LIMITS
};
