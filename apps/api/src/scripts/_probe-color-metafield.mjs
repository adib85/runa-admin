import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import { GraphQLClient, gql } from "graphql-request";

const SHOP = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const r0 = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
const token = (await r0.json())?.data?.accessToken;

const c = new GraphQLClient(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
  headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
});

const Q = gql`
  query {
    products(first: 5, query: "status:active") {
      edges { node {
        handle
        title
        cm: metafield(namespace: "customAttributes", key: "colour") { namespace key type value }
        all: metafields(first: 50) { edges { node { namespace key type value } } }
      } }
    }
  }
`;
const r = await c.request(Q);
for (const e of r.products.edges) {
  const p = e.node;
  console.log("\n", p.handle);
  console.log("  customAttributes.colour =", p.cm?.value, " (type:", p.cm?.type, ")");
  const colorish = p.all.edges
    .map(x => x.node)
    .filter(m => /colou?r/i.test(m.key) || /colou?r/i.test(m.namespace));
  for (const m of colorish) console.log(`  → ${m.namespace}.${m.key} [${m.type}] = ${m.value?.slice?.(0,120)}`);
}
