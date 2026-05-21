#!/usr/bin/env node
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import AWS from "aws-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { AWS_REGION } from "../sync/services/config.js";

AWS.config.update({ region: AWS_REGION });
const docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

const STORE_ID = "toffro.vtexcommercestable.com.br";

async function main() {
  // Pull a few cache entries for TOFF and dump structure of one CTL + one Similar
  const res = await docClient.query({
    TableName: CACHE_TABLE,
    IndexName: "storeId-index",
    KeyConditionExpression: "storeId = :s",
    ExpressionAttributeValues: { ":s": STORE_ID },
    Limit: 50,
  }).promise();

  console.log(`Pulled ${res.Items.length} cache items for ${STORE_ID}\n`);

  let ctlSample = null;
  let simSample = null;

  for (const item of res.Items) {
    if (!ctlSample && item.id?.includes("_") && !item.id.includes("similar_products") && !item.id.includes("userOptions") && item.data?.outfits) {
      ctlSample = item;
    }
    if (!simSample && item.id?.includes("similar_products") && item.data?.products) {
      simSample = item;
    }
    if (ctlSample && simSample) break;
  }

  if (ctlSample) {
    console.log("──[ CTL sample ]──────────────────────────────────────────────");
    console.log(`id: ${ctlSample.id}`);
    console.log(`Top-level keys: ${Object.keys(ctlSample.data).join(", ")}`);
    const outfit = ctlSample.data.outfits?.[0];
    if (outfit) {
      console.log(`First outfit keys: ${Object.keys(outfit).join(", ")}`);
      const prod = outfit.products_for_outfit?.[0];
      if (prod) {
        console.log(`First product keys: ${Object.keys(prod).join(", ")}`);
        console.log(`First product (full):`);
        console.log(JSON.stringify(prod, null, 2));
      }
    }
  } else {
    console.log("No CTL sample found in first 50 items.");
  }

  if (simSample) {
    console.log("\n──[ Similar Products sample ]────────────────────────────────");
    console.log(`id: ${simSample.id}`);
    console.log(`Top-level keys: ${Object.keys(simSample.data).join(", ")}`);
    const prod = simSample.data.products?.[0];
    if (prod) {
      console.log(`First product keys: ${Object.keys(prod).join(", ")}`);
      console.log(`First product (full):`);
      console.log(JSON.stringify(prod, null, 2));
    }
  } else {
    console.log("\nNo Similar Products sample found in first 50 items.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
