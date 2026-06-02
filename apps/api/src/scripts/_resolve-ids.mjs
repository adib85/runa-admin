import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/adrian/Mobile/runa-admin/.env") });
import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";

const SHOP = "bronze-snake-1.myshopify.com";
const API = "2025-10";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const IDS = process.argv.slice(2);

async function token() {
  if (process.env.SHOP_TOKEN) return process.env.SHOP_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  return (await r.json())?.data?.accessToken;
}
const Q = gql`
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id handle title
        colour: metafield(namespace: "customAttributes", key: "colour") { value }
        rc: metafield(namespace: "custom", key: "related_colourways") { value }
      }
    }
  }`;
async function main() {
  const client = new GraphQLClient(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    headers: { "X-Shopify-Access-Token": await token(), "Content-Type": "application/json" } });
  const ids = IDS.map(x => x.startsWith("gid://") ? x : `gid://shopify/Product/${x}`);
  const r = await client.request(Q, { ids });
  for (const n of r.nodes) {
    if (!n) { console.log("  (null node)"); continue; }
    const rc = n.rc?.value ? JSON.parse(n.rc.value) : [];
    console.log(`- ${n.handle}  | color=${n.colour?.value || "?"}  | id=${n.id.split("/").pop()}`);
    console.log(`     related_colourways (${rc.length}): ${rc.map(x => x.split("/").pop()).join(", ")}`);
  }
}
main().catch(e => { console.error("ERR", e?.response?.errors || e); process.exit(1); });
