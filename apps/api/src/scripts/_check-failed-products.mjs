import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import neo4j from "neo4j-driver";
import AWS from "aws-sdk";

AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const STORE = "bronze-snake-1.myshopify.com";

const HANDLES = [
  "jersey-crop-polo-sand",
  "ziah-mini-dress-wine",
  "stasi-set-snake",
  "lyra-denim-halter-white",
  "charli-mini-dress-stone",
];

const driver = neo4j.driver(
  process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
  neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
);
const session = driver.session();

console.log(`\n${"handle".padEnd(35)} ${"neo4j ts".padEnd(28)} ${"cache?".padEnd(8)} ${"chips"}`);
console.log("─".repeat(90));

for (const h of HANDLES) {
  const r = await session.run(
    `MATCH (p:Product {storeId: $s, handle: $h})
     RETURN p.id AS id, p.title AS title,
            toString(p.ask_ai_options_updated_at) AS ts,
            p.ask_ai_options_count AS count,
            p.ask_ai_options_skipped_reason AS skipped`,
    { s: STORE, h }
  );
  if (r.records.length === 0) {
    console.log(`  ${h.padEnd(33)} NOT FOUND in Neo4j`);
    continue;
  }
  const rec = r.records[0];
  const ts = rec.get("ts") || "(NULL — still missing)";
  const skipped = rec.get("skipped");
  const cacheRes = await ddb.get({
    TableName: TABLE,
    Key: { id: `${STORE}_userOptions_${h}_en` }
  }).promise();
  const cached = cacheRes.Item?.data?.userOptions;
  const cacheStr = cached ? `${cached.length} chips` : "(no cache)";
  const cacheFlag = cached ? "yes" : "NO";
  console.log(`  ${h.padEnd(33)} ${ts.slice(0,26).padEnd(28)} ${cacheFlag.padEnd(8)} ${cacheStr}`);
  if (skipped) console.log(`  ${" ".repeat(35)} ↳ skipped reason: ${skipped}`);
  if (cached && cached.length) console.log(`  ${" ".repeat(35)} ↳ first chip: ${JSON.stringify(cached[0])}`);
}

await session.close();
await driver.close();
