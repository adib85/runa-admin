#!/usr/bin/env node

/**
 * Resume Shopify Description Sync
 * Picks up where a previous sync-shopify-descriptions.js run stopped.
 *
 * Usage:
 *   node apps/api/src/scripts/sync-shopify-descriptions-resume.js <storeId> <skip>
 *
 * Example:
 *   node apps/api/src/scripts/sync-shopify-descriptions-resume.js wp557k-d1.myshopify.com 3243
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const RATE_LIMIT_DELAY_MS = 500;

const args = process.argv.slice(2);
const STORE_ID = args[0];
const SKIP = parseInt(args[1], 10);

if (!STORE_ID || isNaN(SKIP)) {
  console.error("Usage: node sync-shopify-descriptions-resume.js <storeId> <skip>");
  console.error("Example: node sync-shopify-descriptions-resume.js wp557k-d1.myshopify.com 3243");
  process.exit(1);
}

async function fetchAccessToken(shop) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shop}`;
  const res = await fetch(url);
  const data = await res.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No accessToken found for shop "${shop}"`);
  return token;
}

const UPDATE_MUTATION = gql`
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id descriptionHtml }
      userErrors { field message }
    }
  }
`;

async function main() {
  const accessToken = await fetchAccessToken(STORE_ID);
  console.log(`Access token fetched for ${STORE_ID}`);

  const shopifyClient = new GraphQLClient(`https://${STORE_ID}/admin/api/2023-04/graphql.json`, {
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" }
  });

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();

  const countResult = await session.run(
    `MATCH (p:Product) WHERE p.storeId = $s
     AND p.description IS NOT NULL AND trim(p.description) <> ""
     AND p.descriptionSource IS NOT NULL AND p.descriptionSource <> "original"
     RETURN count(p) AS total`,
    { s: STORE_ID }
  );
  const total = countResult.records[0].get("total").toInt();

  const result = await session.run(
    `MATCH (p:Product) WHERE p.storeId = $s
     AND p.description IS NOT NULL AND trim(p.description) <> ""
     AND p.descriptionSource IS NOT NULL AND p.descriptionSource <> "original"
     RETURN p.id AS id, p.title AS title, p.description AS description
     ORDER BY p.updated_at DESC
     SKIP $skip`,
    { s: STORE_ID, skip: neo4j.int(SKIP) }
  );
  await session.close();

  const remaining = result.records.length;
  console.log(`\nTotal products: ${total}`);
  console.log(`Skipping first: ${SKIP}`);
  console.log(`Remaining to sync: ${remaining}\n`);

  let updated = 0;
  let errors = 0;

  for (const r of result.records) {
    const id = r.get("id");
    const title = r.get("title");
    const desc = r.get("description");
    const idx = SKIP + updated + errors + 1;

    try {
      const { productUpdate } = await shopifyClient.request(UPDATE_MUTATION, {
        input: { id: `gid://shopify/Product/${id}`, descriptionHtml: desc }
      });

      if (productUpdate.userErrors.length > 0) {
        throw new Error(productUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join(", "));
      }

      const s2 = driver.session();
      await s2.run(
        `MATCH (p:Product {id: $id, storeId: $s}) SET p.description_synced_at = $t`,
        { id, s: STORE_ID, t: new Date().toISOString() }
      );
      await s2.close();

      updated++;
      console.log(`[${idx}/${total}] "${title}" — UPDATED (${desc.length} chars)`);
    } catch (e) {
      errors++;
      console.error(`[${idx}/${total}] "${title}" — ERROR: ${e.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }

  await driver.close();

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Resume complete`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Errors:  ${errors}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
