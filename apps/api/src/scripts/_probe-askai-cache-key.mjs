import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// Try every plausible key shape the lambda might use for hallie-shirt-chocolate
const HANDLE = "hallie-shirt-chocolate";
const candidates = [
  `bronze-snake-1.myshopify.com_userOptions_${HANDLE}_en`,
  `bronzesnake.com_userOptions_${HANDLE}_en`,
  `bronze-snake-1.myshopify.com_askAiOptions_${HANDLE}_en`,
  `bronze-snake-1.myshopify.com_ask_ai_${HANDLE}_en`,
  `bronze-snake-1.myshopify.com_ai_stylist_${HANDLE}_en`,
  `bronze-snake-1.myshopify.com_${HANDLE}_userOptions_en`,
  `bronze-snake-1.myshopify.com_userOptions_${HANDLE}`,
  `userOptions_bronze-snake-1.myshopify.com_${HANDLE}_en`,
];
console.log("Probing candidate cache keys:");
for (const id of candidates) {
  const r = await ddb.get({ TableName: TABLE, Key: { id } }).promise();
  console.log(`  ${r.Item ? "FOUND " : "miss  "} ${id}`);
  if (r.Item) console.log(`        data keys: ${Object.keys(r.Item.data || {}).join(", ")}`);
}
