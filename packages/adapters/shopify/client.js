import { GraphQLClient } from "graphql-request";
import config from "@runa/config";

/**
 * Shopify GraphQL client
 */

/**
 * Create a Shopify GraphQL client for a store
 * @param {string} shopDomain - Shop domain (e.g., "mystore.myshopify.com")
 * @param {string} accessToken - Shopify access token
 * @returns {GraphQLClient}
 */
export function createShopifyClient(shopDomain, accessToken) {
  const endpoint = `https://${shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

  return new GraphQLClient(endpoint, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  });
}

/**
 * GraphQL Queries
 */
export const queries = {
  // Get product count
  productsCount: `
    query ProductsCount {
      productsCount {
        count
      }
    }
  `,

  // List products with pagination
  listProducts: `
    query ListProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          cursor
          node {
            id
            title
            handle
            descriptionHtml
            vendor
            productType
            status
            tags
            createdAt
            updatedAt
            featuredImage {
              url
              altText
            }
            images(first: 10) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  compareAtPrice
                  availableForSale
                  inventoryQuantity
                  selectedOptions {
                    name
                    value
                  }
                  image {
                    url
                  }
                }
              }
            }
            collections(first: 10) {
              edges {
                node {
                  id
                  title
                  handle
                }
              }
            }
            metafields(first: 20) {
              edges {
                node {
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }
      }
    }
  `,

  // Get single product
  getProduct: `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        status
        tags
        createdAt
        updatedAt
        featuredImage {
          url
          altText
        }
        images(first: 20) {
          edges {
            node {
              url
              altText
            }
          }
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
              selectedOptions {
                name
                value
              }
              image {
                url
              }
            }
          }
        }
        collections(first: 10) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
        metafields(first: 50) {
          edges {
            node {
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  `,

  // List collections
  listCollections: `
    query ListCollections($first: Int!, $after: String) {
      collections(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            description
            productsCount {
              count
            }
            image {
              url
            }
          }
        }
      }
    }
  `,

  // Get collection products
  collectionProducts: `
    query CollectionProducts($id: ID!, $first: Int!, $after: String) {
      collection(id: $id) {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    }
  `
};

/**
 * Execute a GraphQL query with retry logic
 * @param {GraphQLClient} client - GraphQL client
 * @param {string} query - GraphQL query
 * @param {Object} variables - Query variables
 * @param {number} retries - Number of retries
 * @returns {Promise<Object>} - Query result
 */
export async function executeQuery(client, query, variables = {}, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await client.request(query, variables);
    } catch (error) {
      lastError = error;

      // Log the error for debugging
      if (i === 0) {
        console.error(`GraphQL query failed (attempt ${i + 1}/${retries}):`, error.message);
        if (error.response?.errors) {
          console.error("GraphQL errors:", JSON.stringify(error.response.errors, null, 2));
        }
      }

      // Check for rate limiting
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers?.get("retry-after") || 2;
        console.log(`Rate limited, waiting ${retryAfter}s...`);
        await delay(retryAfter * 1000);
        continue;
      }

      // Check for throttling in response
      if (error.response?.errors?.some((e) => e.message?.includes("Throttled"))) {
        console.log("Throttled, waiting 1s...");
        await delay(1000);
        continue;
      }

      // For validation errors, don't retry
      if (error.message?.includes("Validation failed") || 
          error.response?.errors?.some((e) => e.message?.includes("Validation"))) {
        throw error;
      }

      // For other errors, retry with backoff
      if (i < retries - 1) {
        const backoff = Math.pow(2, i) * 500;
        console.log(`Retrying in ${backoff}ms...`);
        await delay(backoff);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  createShopifyClient,
  queries,
  executeQuery
};
