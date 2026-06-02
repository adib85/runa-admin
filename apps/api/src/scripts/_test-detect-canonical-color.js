#!/usr/bin/env node
/**
 * Quick smoke test for detectCanonicalColor.
 * Fetches a couple of Bronze Snake products that don't have the
 * customAttributes.colour metafield and runs them through Gemini.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GraphQLClient, gql } from "graphql-request";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import {
  detectCanonicalColor,
  BRONZE_SNAKE_CANONICAL_COLORS,
} from "../sync/services/detect-canonical-color.js";

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const Q = gql`
  query ($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      edges { node {
        id handle title
        featuredImage { url }
        m: metafield(namespace: "customAttributes", key: "colour") { value }
      } }
    }
  }
`;

const r0 = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
const token = (await r0.json())?.data?.accessToken;
const c = new GraphQLClient(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
  headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
});

console.log(`Looking for products without customAttributes.colour metafield…`);
const resp = await c.request(Q, { first: 100, query: "status:active AND published_status:published" });
const candidates = resp.products.edges
  .map(e => e.node)
  .filter(n => !n.m?.value && n.featuredImage?.url)
  .slice(0, 5);

if (candidates.length === 0) {
  console.log("No candidates in first 100 products. The first-page products mostly have the metafield set.");
  console.log("Run the full backfill --gemini --limit 200 to find some.");
  process.exit(0);
}

console.log(`Testing ${candidates.length} products:`);
for (const p of candidates) {
  console.log(`\n  ${p.handle}`);
  console.log(`  title: ${p.title}`);
  console.log(`  image: ${p.featuredImage.url}`);
  const r = await detectCanonicalColor({ title: p.title, imageUrl: p.featuredImage.url });
  console.log(`  → ${r.color || "(null)"}  ${r.reason ? `— ${r.reason}` : ""}`);
}

console.log(`\nAllowed colors: ${BRONZE_SNAKE_CANONICAL_COLORS.length}`);
