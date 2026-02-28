/**
 * Platform adapter interfaces and common types
 * All platform adapters must implement these interfaces
 */

/**
 * @typedef {Object} Product
 * @property {string} id - Unique product ID
 * @property {string} title - Product title
 * @property {string} description - Product description (HTML stripped)
 * @property {string} descriptionHtml - Original HTML description
 * @property {string} handle - URL handle/slug
 * @property {string} vendor - Vendor/brand name
 * @property {string} productType - Product type
 * @property {Array<string>} tags - Product tags
 * @property {Array<string>} images - Image URLs
 * @property {string} featuredImage - Main image URL
 * @property {Array<Variant>} variants - Product variants
 * @property {Array<string>} collections - Collection/category names
 * @property {Object} metafields - Custom metafields
 * @property {string} createdAt - Creation date
 * @property {string} updatedAt - Last update date
 * @property {string} status - Product status (active, draft, archived)
 */

/**
 * @typedef {Object} Variant
 * @property {string} id - Variant ID
 * @property {string} title - Variant title
 * @property {string} sku - SKU code
 * @property {number} price - Price as number
 * @property {number|null} compareAtPrice - Compare at price
 * @property {string} currency - Currency code
 * @property {boolean} available - Is available for sale
 * @property {number} inventoryQuantity - Stock quantity
 * @property {string} color - Color option
 * @property {string} size - Size option
 * @property {string} image - Variant-specific image URL
 * @property {Object} options - All variant options
 */

/**
 * @typedef {Object} Collection
 * @property {string} id - Collection ID
 * @property {string} title - Collection title
 * @property {string} handle - URL handle
 * @property {string} description - Collection description
 * @property {string} image - Collection image URL
 * @property {number} productsCount - Number of products
 */

/**
 * @typedef {Object} ProductPage
 * @property {Array<Product>} products - Array of products
 * @property {boolean} hasNextPage - Whether there are more products
 * @property {string|null} cursor - Cursor for next page
 * @property {number} totalCount - Total product count (if available)
 */

/**
 * Platform adapter interface
 * All platform adapters should implement these methods
 */
export const PlatformAdapterInterface = {
  /**
   * Get total product count
   * @returns {Promise<number>}
   */
  getProductCount: async () => {},

  /**
   * Get products with pagination
   * @param {Object} options - { cursor, limit }
   * @returns {Promise<ProductPage>}
   */
  getProducts: async (options) => {},

  /**
   * Get a single product by ID
   * @param {string} productId
   * @returns {Promise<Product|null>}
   */
  getProduct: async (productId) => {},

  /**
   * Get all collections/categories
   * @returns {Promise<Array<Collection>>}
   */
  getCollections: async () => {},

  /**
   * Get products in a collection
   * @param {string} collectionId
   * @param {Object} options - { cursor, limit }
   * @returns {Promise<ProductPage>}
   */
  getCollectionProducts: async (collectionId, options) => {},

  /**
   * Register webhooks for real-time updates
   * @param {string} callbackUrl
   * @returns {Promise<void>}
   */
  registerWebhooks: async (callbackUrl) => {},

  /**
   * Verify webhook signature
   * @param {Object} headers - Request headers
   * @param {string} body - Raw request body
   * @returns {boolean}
   */
  verifyWebhook: (headers, body) => {}
};

/**
 * Supported platforms
 */
export const PLATFORMS = {
  SHOPIFY: "shopify",
  WOOCOMMERCE: "woocommerce",
  VTEX: "vtex",
  BIGCOMMERCE: "bigcommerce",
  CUSTOM: "custom"
};

export default {
  PLATFORMS,
  PlatformAdapterInterface
};
