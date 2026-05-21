import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const STORE = "bronze-snake-1.myshopify.com";
const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
let scanned = 0, lastKey, byShape = {};
do {
  const r = await ddb.query({
    TableName: TABLE, IndexName: "storeId-index",
    KeyConditionExpression: "storeId = :s",
    ExpressionAttributeValues: { ":s": STORE },
    ExclusiveStartKey: lastKey, Limit: 200,
  }).promise();
  for (const it of r.Items || []) {
    scanned++;
    const id = it.id || "";
    let shape = "other";
    if (id.includes("_similar_products_")) shape = "similar_products";
    else if (id.includes("_userOptions_") || id.includes("userOptions")) shape = "userOptions";
    else if (it.data?.outfits) shape = "ctl_outfits";
    else if (it.data?.products) shape = "products_only";
    byShape[shape] = byShape[shape] || { count: 0, sample: null };
    byShape[shape].count++;
    if (!byShape[shape].sample) byShape[shape].sample = { id, dataKeys: Object.keys(it.data || {}), data: it.data };
  }
  lastKey = r.LastEvaluatedKey;
  if (scanned > 1500) break;
} while (lastKey);
console.log(`Scanned ${scanned} cache items for ${STORE}\n`);
for (const [shape, info] of Object.entries(byShape)) {
  console.log(`── ${shape}: ${info.count} items`);
  console.log(`   sample id: ${info.sample.id}`);
  console.log(`   top keys: ${info.sample.dataKeys.join(", ")}`);
  if (shape === "ctl_outfits") {
    const o = info.sample.data.outfits?.[0];
    if (o) console.log(`   outfit keys: ${Object.keys(o).join(", ")}`);
    const p = o?.products_for_outfit?.[0];
    if (p) console.log(`   product keys: ${Object.keys(p).join(", ")}\n   product sample: ${JSON.stringify(p).slice(0,400)}`);
  }
  if (shape === "userOptions") {
    console.log(`   data sample: ${JSON.stringify(info.sample.data).slice(0,800)}`);
  }
  console.log("");
}
