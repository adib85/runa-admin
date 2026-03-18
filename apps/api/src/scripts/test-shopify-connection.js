#!/usr/bin/env node

import { GraphQLClient, gql } from "graphql-request";
import Shopify from "shopify-api-node";
import fetch from "node-fetch";

const SHOP_DOMAIN = process.argv[2] || process.env.SHOP_DOMAIN || "k8xbf0-5t.myshopify.com";
const ACCESS_TOKEN = process.argv[3] || process.env.ACCESS_TOKEN;

async function main() {
  console.log(`\n  Store:  ${SHOP_DOMAIN}`);
  console.log(`  Token:  ${ACCESS_TOKEN.substring(0, 10)}...${ACCESS_TOKEN.slice(-4)}`);
  console.log(`  Length: ${ACCESS_TOKEN.length} chars\n`);

  // ── Test 1: Raw REST call ──
  console.log("── Test 1: Raw REST API (fetch) ──");
  try {
    const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/2023-04/shop.json`, {
      headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  Shop name: ${data.shop.name}`);
      console.log(`  Currency:  ${data.shop.currency}`);
      console.log(`  ✓ REST works\n`);
    } else {
      const body = await res.text();
      console.log(`  ✗ REST failed: ${body}\n`);
    }
  } catch (e) {
    console.log(`  ✗ REST error: ${e.message}\n`);
  }

  // ── Test 2: shopify-api-node (same lib used by sync) ──
  console.log("── Test 2: shopify-api-node library ──");
  try {
    const shopifyApi = new Shopify({ shopName: SHOP_DOMAIN, accessToken: ACCESS_TOKEN });
    const shop = await shopifyApi.shop.get();
    console.log(`  Shop name: ${shop.name}`);
    console.log(`  ✓ shopify-api-node works\n`);
  } catch (e) {
    console.log(`  ✗ shopify-api-node failed: ${e.message}\n`);
  }

  // ── Test 3: GraphQL (same client used by sync) ──
  console.log("── Test 3: GraphQL Admin API ──");
  try {
    const client = new GraphQLClient(`https://${SHOP_DOMAIN}/admin/api/2023-04/graphql.json`, {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    });

    const { productsCount } = await client.request(gql`
      query { productsCount(query: "status:active") { count } }
    `);
    console.log(`  Active products: ${productsCount.count}`);
    console.log(`  ✓ GraphQL works\n`);

    const { products } = await client.request(gql`
      query {
        products(first: 1, query: "status:active") {
          edges {
            node {
              id title handle vendor productType
              variants(first: 3) {
                edges { node { id title sku price inventoryQuantity selectedOptions { name value } } }
              }
              collections(first: 5) { edges { node { title } } }
              images(first: 1) { edges { node { src } } }
            }
          }
        }
      }
    `);

    const node = products.edges[0]?.node;
    if (node) {
      console.log("── Sample product ──");
      console.log(`  Title:       ${node.title}`);
      console.log(`  Handle:      ${node.handle}`);
      console.log(`  Vendor:      ${node.vendor}`);
      console.log(`  Type:        ${node.productType || "(empty)"}`);
      console.log(`  Image:       ${node.images?.edges?.[0]?.node?.src || "(none)"}`);
      console.log(`  Collections: ${node.collections?.edges?.map(e => e.node.title).join(", ") || "(none)"}`);
      for (const { node: v } of node.variants.edges) {
        const opts = v.selectedOptions.map(o => `${o.name}=${o.value}`).join(", ");
        console.log(`  Variant:     ${v.title} — SKU: ${v.sku ? `"${v.sku}"` : "(empty)"} — $${v.price} — stock: ${v.inventoryQuantity} — ${opts}`);
      }
    }
  } catch (e) {
    console.log(`  ✗ GraphQL failed: ${e.message}\n`);
  }

  // ── Test 4: Collections (same calls used by sync) ──
  console.log("\n── Test 4: Collections (shopify-api-node) ──");
  try {
    const shopifyApi = new Shopify({ shopName: SHOP_DOMAIN, accessToken: ACCESS_TOKEN });
    const custom = await shopifyApi.customCollection.list();
    const smart = await shopifyApi.smartCollection.list();
    console.log(`  Custom collections: ${custom.length}`);
    console.log(`  Smart collections:  ${smart.length}`);
    console.log(`  Total: ${custom.length + smart.length}`);
    console.log(`  ✓ Collections work\n`);
  } catch (e) {
    console.log(`  ✗ Collections failed: ${e.message}\n`);
  }
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});
