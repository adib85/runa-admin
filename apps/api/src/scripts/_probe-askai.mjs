import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/adrian/Mobile/runa-admin/.env") });

import AWS from "aws-sdk";
import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";

const SHOP = "bronze-snake-1.myshopify.com";
const HANDLE = "collar-lined-jacket-black";
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

async function getToken() {
  if (process.env.SHOP_TOKEN) return process.env.SHOP_TOKEN;
  const res = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const data = await res.json();
  return data?.data?.accessToken;
}

async function main() {
  // 1) Probe several likely cache keys (lang variants + casing)
  const langs = ["en", "ro"];
  console.log("=== DynamoDB cache probe ===");
  for (const lang of langs) {
    const id = `${SHOP.toLowerCase()}_userOptions_${HANDLE.toLowerCase()}_${lang}`;
    const res = await ddb.get({ TableName: CACHE_TABLE, Key: { id } }).promise();
    if (!res.Item) {
      console.log(`  [${lang}] key=${id}  -> NOT FOUND`);
      continue;
    }
    const raw = res.Item?.data?.userOptions ?? res.Item?.userOptions;
    console.log(`  [${lang}] key=${id}  -> FOUND`);
    console.log(`        updatedAt: ${res.Item.updatedAt || res.Item.timestamp || res.Item.ttl || "(none)"}`);
    console.log(`        userOptions:`, JSON.stringify(raw, null, 2));
  }

  // 2) Read the LIVE Shopify metafield
  console.log("\n=== Live Shopify metafield (runa.ask_ai_options) ===");
  const token = await getToken();
  const client = new GraphQLClient(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  const q = gql`
    query($handle: String!) {
      productByHandle(handle: $handle) {
        id handle
        metafield(namespace: "runa", key: "ask_ai_options") { id type value updatedAt }
      }
    }`;
  const r = await client.request(q, { handle: HANDLE });
  console.log("  product:", r?.productByHandle?.id, r?.productByHandle?.handle);
  console.log("  metafield:", JSON.stringify(r?.productByHandle?.metafield, null, 2));
}

main().catch(e => { console.error("ERR", e); process.exit(1); });
