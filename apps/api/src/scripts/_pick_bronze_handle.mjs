import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });

import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

const STORE = "bronze-snake-1.myshopify.com";
const res = await ddb.query({
  TableName: process.env.DYNAMODB_CACHE_TABLE || "CacheTable",
  IndexName: "storeId-index",
  KeyConditionExpression: "storeId = :s",
  ExpressionAttributeValues: { ":s": STORE },
  Limit: 200,
}).promise();

const sims = (res.Items || []).filter(i =>
  typeof i.id === "string" && i.id.includes("_similar_products_") && Array.isArray(i.data?.products) && i.data.products.length > 0
);

console.log(`scanned ${res.Items?.length || 0}, found ${sims.length} similar_products entries\n`);
for (const it of sims.slice(0, 8)) {
  const m = it.id.match(/_similar_products_(.+)_([a-z]{2})$/i);
  const handle = m?.[1] || "?";
  console.log(`  handle=${handle}  cached_count=${it.data.products.length}  cacheId=${it.id}`);
}
