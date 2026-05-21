import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const STORE = "bronze-snake-1.myshopify.com";
const HANDLE = process.argv[2] || "hallie-shirt-chocolate";
const r = await ddb.get({
  TableName: process.env.DYNAMODB_CACHE_TABLE || "CacheTable",
  Key: { id: `${STORE}_${HANDLE}_en` },
}).promise();
const d = r.Item?.data || {};
console.log("── userOptions field (the ask-ai chips) ──");
console.log(JSON.stringify(d.userOptions, null, 2)?.slice(0, 2000));
console.log("\n── description (top-level) (truncated) ──");
console.log(String(d.description || "").slice(0, 500));
console.log("\n── outfits length:", d.outfits?.length, "  unique product ids in CTL:");
const ids = new Set();
for (const o of d.outfits || []) for (const p of o.products_for_outfit || []) if (p.id) ids.add(String(p.id));
console.log(`   total unique = ${ids.size}: ${Array.from(ids).slice(0,12).join(", ")}${ids.size>12?", …":""}`);
