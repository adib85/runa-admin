#!/usr/bin/env node

import { GraphQLClient, gql } from "graphql-request";

const SHOP_DOMAIN = process.argv[2] || process.env.SHOP_DOMAIN || "k8xbf0-5t.myshopify.com";
const ACCESS_TOKEN = process.argv[3] || process.env.ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error("Usage: node test-shopify-product-stock.js [shop] <access_token>");
  process.exit(1);
}

const MIN_STOCK = 2;
const MIN_IMAGES = 3;

const GET_PRODUCTS = gql`
  query ($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      edges {
        node {
          id
          title
          handle
          totalVariants
          images(first: 50) {
            edges {
              node { id }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                inventoryQuantity
              }
            }
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

async function main() {
  const client = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
    headers: {
      "X-Shopify-Access-Token": ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  });

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Product Stock Test — ${SHOP_DOMAIN}`);
  console.log(`  Filter: images >= ${MIN_IMAGES}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  let hasNextPage = true;
  let afterCursor = null;
  let totalProducts = 0;
  const matchingProducts = [];

  while (hasNextPage) {
    const response = await client.request(GET_PRODUCTS, { first: 50, after: afterCursor });
    const edges = response.products.edges;

    for (const { node, cursor } of edges) {
      totalProducts++;
      afterCursor = cursor;

      const variants = node.variants.edges.map(e => e.node);
      const variantCount = variants.length;
      const totalStock = variants.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0);
      const imageCount = node.images.edges.length;

      if (imageCount >= MIN_IMAGES) {
        matchingProducts.push({
          title: node.title,
          handle: node.handle,
          variantCount,
          totalStock,
          imageCount,
        });
      }
    }

    hasNextPage = response.products.pageInfo.hasNextPage;
    process.stdout.write(`\r  Scanned ${totalProducts} products...`);
  }

  console.log(`\r  Scanned ${totalProducts} products — done.      \n`);

  console.log(`── Matching Products (${matchingProducts.length}) ──\n`);
  for (const p of matchingProducts) {
    console.log(`  ${p.title}`);
    console.log(`    handle: ${p.handle}  |  variants: ${p.variantCount}  |  stock: ${p.totalStock}  |  images: ${p.imageCount}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Total active products:  ${totalProducts}`);
  console.log(`  Matching (images >= ${MIN_IMAGES}):  ${matchingProducts.length}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});
