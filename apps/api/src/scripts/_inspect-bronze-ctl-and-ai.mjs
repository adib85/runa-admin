import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import AWS from "aws-sdk";
AWS.config.update({ region: "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const STORE = "bronze-snake-1.myshopify.com";
const HANDLE = process.argv[2] || "hallie-shirt-chocolate";
const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

const ctlId  = `${STORE}_${HANDLE}_en`;
const aiId   = `${STORE}_userOptions_${HANDLE}_en`;
const simId  = `${STORE}_similar_products_${HANDLE}_en`;

async function get(id) {
  const r = await ddb.get({ TableName: TABLE, Key: { id } }).promise();
  return r.Item || null;
}

console.log(`\n── CTL: ${ctlId}`);
const ctl = await get(ctlId);
if (!ctl) console.log("  not found");
else {
  console.log("  top keys:", Object.keys(ctl.data || {}).join(", "));
  const o = ctl.data?.outfits?.[0];
  if (o) {
    console.log("  outfits[0] keys:", Object.keys(o).join(", "));
    const p = o.products_for_outfit?.[0];
    if (p) {
      console.log("  outfit_products[0] keys:", Object.keys(p).join(", "));
      console.log("  outfit_products[0] sample:", JSON.stringify(p).slice(0,500));
    }
    console.log(`  outfits.length = ${ctl.data.outfits.length}`);
  }
}

console.log(`\n── userOptions / Ask AI: ${aiId}`);
const ai = await get(aiId);
if (!ai) console.log("  not found");
else {
  console.log("  top keys:", Object.keys(ai.data || {}).join(", "));
  console.log("  data sample:", JSON.stringify(ai.data).slice(0, 1500));
}

console.log(`\n── Similar (sanity): ${simId}`);
const sim = await get(simId);
if (!sim) console.log("  not found");
else {
  console.log("  products.length =", sim.data?.products?.length || 0);
}
