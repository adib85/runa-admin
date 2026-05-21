import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });

import { GraphQLClient, gql } from "graphql-request";
import fetch from "node-fetch";

const SHOP  = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

async function fetchAccessTokenFromDB(shop) {
  const res = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${shop}`);
  const data = await res.json();
  const token = data?.data?.accessToken;
  if (!token) throw new Error(`No accessToken found in Lambda DB for shop "${shop}"`);
  return token;
}

const TOKEN = process.env.SHOP_TOKEN || (await fetchAccessTokenFromDB(SHOP));

const c = new GraphQLClient(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
  headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
});

// 1. Fetch the actual color-pattern metaobjects we saw on Carli Top Ivory + Black
const GIDS = [
  "gid://shopify/Metaobject/80390389805", // Ivory product → ?
  "gid://shopify/Metaobject/80148922413", // Black product → ?
];
const NODE = gql`
  query($id:ID!){
    metaobject(id:$id){
      id type handle
      fields { key type value reference { __typename ... on MediaImage { image{ url } } } }
    }
  }
`;
console.log("\n──── color-pattern metaobjects referenced by the two products ────");
for (const id of GIDS) {
  const r = await c.request(NODE, { id });
  const m = r.metaobject;
  if (!m) { console.log("  not found:", id); continue; }
  console.log(`\n  ${m.handle}  (${m.type})  ${m.id}`);
  for (const f of m.fields) {
    let v = f.value;
    if (typeof v === "string" && v.length > 200) v = v.slice(0, 200) + "…";
    const refTag = f.reference?.__typename ? `  ref:${f.reference.__typename}` : "";
    const imgUrl = f.reference?.image?.url ? `  img:${f.reference.image.url}` : "";
    console.log(`     - ${f.key}  [${f.type}]  =  ${v}${refTag}${imgUrl}`);
  }
}

// 3. Also list a handful of all color-pattern metaobjects so we can see the full palette
const LIST = gql`
  query($type:String!,$first:Int!){
    metaobjects(type:$type, first:$first){
      edges{ node{ id handle fields{ key value type } } }
    }
  }
`;
console.log("\n──── first 12 color-pattern metaobjects on the shop ────");
const list = await c.request(LIST, { type: "shopify--color-pattern", first: 12 });
for (const e of list.metaobjects.edges) {
  const m = e.node;
  const summary = m.fields
    .filter(f => f.key !== "image" || f.value)
    .map(f => `${f.key}=${(f.value || "").slice(0, 40)}`)
    .join("  |  ");
  console.log(`  ${m.handle}   ${summary}`);
}
