#!/usr/bin/env node

/**
 * Test script to verify Shopify API connection and debug issues
 * 
 * Usage:
 *   node apps/api/src/scripts/test-shopify-connection.js <shop-domain> <access-token>
 */

import dotenv from "dotenv";
dotenv.config();

import { GraphQLClient } from "graphql-request";

const shopDomain = process.argv[2] || process.env.SHOP_DOMAIN;
const accessToken = process.argv[3] || process.env.ACCESS_TOKEN;

if (!shopDomain || !accessToken) {
  console.error("Usage: node test-shopify-connection.js <shop-domain> <access-token>");
  process.exit(1);
}

console.log(`\n=== Testing Shopify Connection ===`);
console.log(`Shop: ${shopDomain}`);
console.log(`Token: ${accessToken.substring(0, 12)}...${accessToken.substring(accessToken.length - 4)}`);

// Try different API versions
const apiVersions = ["2024-10", "2024-07", "2024-04", "2024-01", "2023-10", "2023-07", "2023-04"];

async function testVersion(version) {
  const endpoint = `https://${shopDomain}/admin/api/${version}/graphql.json`;
  console.log(`\n--- Testing API version ${version} ---`);
  console.log(`Endpoint: ${endpoint}`);

  const client = new GraphQLClient(endpoint, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  });

  // Test 1: Simple shop query
  try {
    console.log("\nTest 1: Basic shop query...");
    const shopQuery = `
      query {
        shop {
          name
          primaryDomain {
            url
          }
          currencyCode
        }
      }
    `;
    const shopResult = await client.request(shopQuery);
    console.log("✓ Shop query successful:");
    console.log(`  Name: ${shopResult.shop.name}`);
    console.log(`  Domain: ${shopResult.shop.primaryDomain?.url}`);
    console.log(`  Currency: ${shopResult.shop.currencyCode}`);
  } catch (error) {
    console.error("✗ Shop query failed:", error.message);
    if (error.response?.errors) {
      console.error("  Errors:", JSON.stringify(error.response.errors, null, 2));
    }
    return false;
  }

  // Test 2: Products count query
  try {
    console.log("\nTest 2: Products count query...");
    const countQuery = `
      query {
        productsCount {
          count
        }
      }
    `;
    const countResult = await client.request(countQuery);
    console.log(`✓ Product count: ${countResult.productsCount.count}`);
  } catch (error) {
    console.error("✗ Products count failed:", error.message);
    if (error.response?.errors) {
      console.error("  Errors:", JSON.stringify(error.response.errors, null, 2));
    }
    // Try alternative count method
    try {
      console.log("  Trying alternative count method...");
      const altCountQuery = `
        query {
          products(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      `;
      await client.request(altCountQuery);
      console.log("  ✓ Alternative query works - productsCount may not be available");
    } catch (altError) {
      console.error("  ✗ Alternative query also failed");
    }
  }

  // Test 3: Fetch first product
  try {
    console.log("\nTest 3: Fetch first product...");
    const productQuery = `
      query {
        products(first: 1) {
          edges {
            node {
              id
              title
              handle
              status
              vendor
              productType
              createdAt
              featuredImage {
                url
              }
              variants(first: 3) {
                edges {
                  node {
                    id
                    title
                    price
                  }
                }
              }
            }
          }
        }
      }
    `;
    const productResult = await client.request(productQuery);
    if (productResult.products.edges.length > 0) {
      const product = productResult.products.edges[0].node;
      console.log("✓ First product:");
      console.log(`  ID: ${product.id}`);
      console.log(`  Title: ${product.title}`);
      console.log(`  Status: ${product.status}`);
      console.log(`  Vendor: ${product.vendor}`);
      console.log(`  Type: ${product.productType}`);
      console.log(`  Variants: ${product.variants.edges.length}`);
    } else {
      console.log("✓ Query worked but no products found");
    }
  } catch (error) {
    console.error("✗ Product fetch failed:", error.message);
    if (error.response?.errors) {
      console.error("  Errors:", JSON.stringify(error.response.errors, null, 2));
    }
    return false;
  }

  // Test 4: Fetch products with all fields (like our sync query)
  try {
    console.log("\nTest 4: Full product query (like sync)...");
    const fullQuery = `
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
    `;
    const result = await client.request(fullQuery, { first: 1, after: null });
    console.log(`✓ Full query successful - ${result.products.edges.length} product(s) returned`);
    if (result.products.edges.length > 0) {
      const p = result.products.edges[0].node;
      console.log(`  Product: ${p.title}`);
      console.log(`  Images: ${p.images.edges.length}`);
      console.log(`  Variants: ${p.variants.edges.length}`);
      console.log(`  Collections: ${p.collections.edges.length}`);
      console.log(`  Metafields: ${p.metafields.edges.length}`);
    }
    return true;
  } catch (error) {
    console.error("✗ Full product query failed:", error.message);
    if (error.response?.errors) {
      console.error("  Errors:", JSON.stringify(error.response.errors, null, 2));
    }
    return false;
  }
}

async function main() {
  let working = false;
  
  for (const version of apiVersions) {
    const success = await testVersion(version);
    if (success) {
      console.log(`\n\n✓ API version ${version} works!`);
      console.log(`Update your config to use this version.`);
      working = true;
      break;
    }
  }

  if (!working) {
    console.log(`\n\n✗ No API version worked. Please check:`);
    console.log(`  1. The access token is valid and not expired`);
    console.log(`  2. The shop domain is correct (should be xxx.myshopify.com)`);
    console.log(`  3. The access token has the required scopes (read_products, etc.)`);
  }
}

main().catch(console.error);
