import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// scan only items whose id contains "hallie-shirt-chocolate"
let lastKey, found = [], scanned = 0;
do {
  const r = await ddb.scan({
    TableName: TABLE,
    FilterExpression: "contains(id, :h)",
    ExpressionAttributeValues: { ":h": "hallie-shirt-chocolate" },
    ExclusiveStartKey: lastKey,
    Limit: 200,
  }).promise();
  scanned += r.ScannedCount || 0;
  for (const it of r.Items || []) {
    found.push({ id: it.id, storeId: it.storeId, dataKeys: Object.keys(it.data || {}) });
  }
  lastKey = r.LastEvaluatedKey;
  if (scanned > 4000) { console.log("(stopping after 4000 scanned)"); break; }
} while (lastKey);

console.log(`scanned ${scanned} items, ${found.length} match hallie-shirt-chocolate`);
for (const f of found) {
  console.log(`  ${f.id}    storeId=${f.storeId}    data keys: ${f.dataKeys.join(", ")}`);
}
