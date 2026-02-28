import { createShopifyClient, queries, executeQuery } from "./client.js";
import {
  transformProduct,
  transformCollection,
  buildAggregatedContent
} from "./transformer.js";
import config from "@runa/config";

/**
 * Shopify Platform Adapter
 * Implements the platform adapter interface for Shopify stores
 */
export class ShopifyAdapter {
  /**
   * Create a Shopify adapter
   * @param {string} shopDomain - Shop domain (e.g., "mystore.myshopify.com")
   * @param {string} accessToken - Shopify Admin API access token
   */
  constructor(shopDomain, accessToken) {
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.client = createShopifyClient(shopDomain, accessToken);
    this.defaultPageSize = config.sync.batchSize;
  }

  /**
   * Get total product count
   * @returns {Promise<number>}
   */
  async getProductCount() {
    // Try the productsCount query first (newer API)
    try {
      const data = await executeQuery(this.client, queries.productsCount);
      if (data.productsCount?.count !== undefined) {
        return data.productsCount.count;
      }
    } catch (error) {
      console.log("productsCount query not available, trying alternative method...");
    }

    // Fallback: count by fetching products in pages
    // This is slower but works on all API versions
    try {
      let count = 0;
      let hasNextPage = true;
      let cursor = null;

      while (hasNextPage) {
        const data = await executeQuery(this.client, `
          query CountProducts($first: Int!, $after: String) {
            products(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                }
              }
            }
          }
        `, { first: 250, after: cursor });

        count += data.products.edges.length;
        hasNextPage = data.products.pageInfo.hasNextPage;
        cursor = data.products.pageInfo.endCursor;
      }

      return count;
    } catch (error) {
      console.error("Failed to count products:", error.message);
      return 0;
    }
  }

  /**
   * Get products with pagination
   * @param {Object} options - { cursor, limit }
   * @returns {Promise<Object>} - { products, hasNextPage, cursor, totalCount }
   */
  async getProducts(options = {}) {
    const { cursor = null, limit = this.defaultPageSize } = options;

    const variables = {
      first: limit,
      after: cursor
    };

    const data = await executeQuery(this.client, queries.listProducts, variables);

    const products = data.products.edges.map((edge) =>
      transformProduct(edge.node)
    );

    return {
      products,
      hasNextPage: data.products.pageInfo.hasNextPage,
      cursor: data.products.pageInfo.endCursor,
      totalCount: null // Shopify doesn't return total in this query
    };
  }

  /**
   * Get all products (auto-paginate)
   * @param {Function} onProgress - Optional progress callback (processed, total)
   * @returns {AsyncGenerator<Object>} - Yields products one by one
   */
  async *getAllProducts(onProgress) {
    let cursor = null;
    let hasNextPage = true;
    let processed = 0;

    const total = await this.getProductCount();

    while (hasNextPage) {
      const page = await this.getProducts({ cursor });

      for (const product of page.products) {
        yield product;
        processed++;

        if (onProgress && processed % 10 === 0) {
          onProgress(processed, total);
        }
      }

      hasNextPage = page.hasNextPage;
      cursor = page.cursor;
    }

    if (onProgress) {
      onProgress(processed, total);
    }
  }

  /**
   * Get all products as array
   * @param {Function} onProgress - Optional progress callback
   * @returns {Promise<Array>} - All products
   */
  async getAllProductsArray(onProgress) {
    const products = [];
    for await (const product of this.getAllProducts(onProgress)) {
      products.push(product);
    }
    return products;
  }

  /**
   * Get a single product by ID
   * @param {string} productId - Product ID (numeric or GraphQL ID)
   * @returns {Promise<Object|null>}
   */
  async getProduct(productId) {
    // Convert numeric ID to GraphQL ID if needed
    const graphqlId = productId.startsWith("gid://")
      ? productId
      : `gid://shopify/Product/${productId}`;

    try {
      const data = await executeQuery(this.client, queries.getProduct, {
        id: graphqlId
      });

      if (!data.product) return null;
      return transformProduct(data.product);
    } catch (error) {
      console.error(`Failed to get product ${productId}:`, error);
      return null;
    }
  }

  /**
   * Get all collections
   * @returns {Promise<Array>}
   */
  async getCollections() {
    const collections = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await executeQuery(this.client, queries.listCollections, {
        first: 50,
        after: cursor
      });

      const pageCollections = data.collections.edges.map((edge) =>
        transformCollection(edge.node)
      );
      collections.push(...pageCollections);

      hasNextPage = data.collections.pageInfo.hasNextPage;
      cursor = data.collections.pageInfo.endCursor;
    }

    return collections;
  }

  /**
   * Get products in a collection
   * @param {string} collectionId - Collection ID
   * @param {Object} options - { cursor, limit }
   * @returns {Promise<Object>}
   */
  async getCollectionProducts(collectionId, options = {}) {
    const { cursor = null, limit = this.defaultPageSize } = options;

    const graphqlId = collectionId.startsWith("gid://")
      ? collectionId
      : `gid://shopify/Collection/${collectionId}`;

    const data = await executeQuery(this.client, queries.collectionProducts, {
      id: graphqlId,
      first: limit,
      after: cursor
    });

    if (!data.collection) {
      return { products: [], hasNextPage: false, cursor: null };
    }

    return {
      products: data.collection.products.edges.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        handle: e.node.handle
      })),
      hasNextPage: data.collection.products.pageInfo.hasNextPage,
      cursor: data.collection.products.pageInfo.endCursor
    };
  }

  /**
   * Build aggregated content for a product (for AI processing)
   * @param {Object} product - Transformed product
   * @returns {string}
   */
  buildAggregatedContent(product) {
    return buildAggregatedContent(product);
  }

  /**
   * Get store info
   * @returns {Object}
   */
  getStoreInfo() {
    return {
      platform: "shopify",
      domain: this.shopDomain,
      apiVersion: config.shopify.apiVersion
    };
  }
}

/**
 * Create a Shopify adapter instance
 * @param {string} shopDomain - Shop domain
 * @param {string} accessToken - Access token
 * @returns {ShopifyAdapter}
 */
export function createAdapter(shopDomain, accessToken) {
  return new ShopifyAdapter(shopDomain, accessToken);
}

export default ShopifyAdapter;
