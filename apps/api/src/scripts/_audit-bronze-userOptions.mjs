import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const STORE = "bronze-snake-1.myshopify.com";
const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

let scanned = 0, ctlItems = 0, withUO = 0, emptyUO = 0, missingUO = 0;
const samples = [];
let lastKey;
do {
  const r = await ddb.query({
    TableName: TABLE, IndexName: "storeId-index",
    KeyConditionExpression: "storeId = :s",
    ExpressionAttributeValues: { ":s": STORE },
    ExclusiveStartKey: lastKey, Limit: 200,
  }).promise();
  for (const it of r.Items || []) {
    scanned++;
    const id = String(it.id || "");
    if (id.includes("_similar_products_") || id.includes("_userOptions_")) continue;
    if (!it.data?.outfits) continue;
    ctlItems++;
    const uo = it.data.userOptions;
    if (uo === undefined || uo === null) { missingUO++; if (samples.length<5) samples.push({id, status:"missing"}); }
    else if (Array.isArray(uo) && uo.length === 0) { emptyUO++; if (samples.length<5) samples.push({id, status:"empty"}); }
    else withUO++;
  }
  lastKey = r.LastEvaluatedKey;
  if (scanned > 5000) break;
} while (lastKey);

console.log(`scanned ${scanned} cache items for ${STORE}`);
console.log(`CTL items (data.outfits present): ${ctlItems}`);
console.log(`  with userOptions array (len > 0): ${withUO}`);
console.log(`  with empty userOptions array:     ${emptyUO}`);
console.log(`  missing userOptions field:        ${missingUO}`);
if (samples.length) {
  console.log(`samples:`);
  for (const s of samples) console.log(`  ${s.status}: ${s.id}`);
}
