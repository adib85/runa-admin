import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });

import { GraphQLClient, gql } from "graphql-request";
import fetch from "node-fetch";

const SHOP  = "bronze-snake-1.myshopify.com";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";
const HANDLES = process.argv.slice(2);
if (!HANDLES.length) {
  console.error("usage: node _inspect-bronzesnake-color.mjs <handle1> [handle2 ...]");
  process.exit(1);
}

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

const Q = gql`
  query($handle:String!){
    productByHandle(handle:$handle){
      id title handle productType vendor tags
      options { id name position values }
      variants(first:50){ edges{ node{ id title selectedOptions{ name value } } } }
      metafields(first:50){ edges{ node{ namespace key type value } } }
    }
  }
`;

for (const h of HANDLES) {
  console.log("\n──────────────────────────────────────────────────");
  console.log("HANDLE:", h);
  const r = await c.request(Q, { handle: h });
  const p = r.productByHandle;
  if (!p) { console.log("  NOT FOUND"); continue; }
  console.log("  id:         ", p.id);
  console.log("  title:      ", p.title);
  console.log("  productType:", p.productType);
  console.log("  vendor:     ", p.vendor);
  console.log("  tags:       ", JSON.stringify(p.tags));
  console.log("  options:");
  for (const o of p.options || []) {
    console.log(`    - ${o.name} (pos ${o.position}) → ${JSON.stringify(o.values)}`);
  }
  console.log(`  variants (${p.variants.edges.length}):`);
  for (const v of p.variants.edges.slice(0, 5)) {
    const opts = v.node.selectedOptions.map(o => `${o.name}=${o.value}`).join(", ");
    console.log(`    - ${v.node.title}  [${opts}]`);
  }
  console.log("  metafields:");
  for (const e of p.metafields.edges) {
    const m = e.node;
    let v = m.value;
    if (typeof v === "string" && v.length > 220) v = v.slice(0, 220) + "…";
    console.log(`    - ${m.namespace}.${m.key}  (${m.type})  =  ${v}`);
  }
}

// Also inspect the live storefront response for the same handles to see if
// the swatch-linked products are exposed there (some apps inject metafields
// under the "swatch_options" / "linked_products" namespace).
console.log("\n──── storefront /products/<handle>.js for first handle ────");
try {
  const r = await fetch(`https://www.bronzesnake.com/products/${HANDLES[0]}.js`);
  const j = await r.json();
  console.log("  keys at root:", Object.keys(j).join(", "));
  if (j.metafields) console.log("  storefront metafields:", JSON.stringify(j.metafields).slice(0, 600));
} catch (e) {
  console.log("  storefront fetch failed:", e.message);
}
