import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/adrian/Mobile/runa-admin/.env") });

import fetch from "node-fetch";
import { GraphQLClient, gql } from "graphql-request";

const SHOP = "bronze-snake-1.myshopify.com";
const HANDLE = process.argv[2] || "collar-lined-jacket-black";
const API = "2025-10";
const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

async function token() {
  if (process.env.SHOP_TOKEN) return process.env.SHOP_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  return (await r.json())?.data?.accessToken;
}

const Q = gql`
  query($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      title
      productType
      tags
      options { name optionValues { name } }
      combinedListingRole
      combinedListing {
        parentProduct { id handle title }
        combinedListingChildren(first: 30) {
          edges { node { product { id handle title } } }
        }
      }
      metafields(first: 60) {
        edges { node { namespace key type value } }
      }
    }
  }
`;

async function main() {
  const client = new GraphQLClient(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    headers: { "X-Shopify-Access-Token": await token(), "Content-Type": "application/json" },
  });
  const r = await client.request(Q, { handle: HANDLE });
  const p = r.productByHandle;
  if (!p) { console.log("NOT FOUND:", HANDLE); return; }

  console.log("=== PRODUCT ===");
  console.log("handle:", p.handle, "| title:", p.title, "| type:", p.productType);
  console.log("tags:", JSON.stringify(p.tags));
  console.log("options:", JSON.stringify(p.options));

  console.log("\n=== COMBINED LISTING ===");
  console.log("combinedListingRole:", p.combinedListingRole);
  if (p.combinedListing) {
    console.log("parentProduct:", JSON.stringify(p.combinedListing.parentProduct));
    const kids = (p.combinedListing.combinedListingChildren?.edges || []).map(e => e.node.product);
    console.log(`children (${kids.length}):`);
    for (const k of kids) console.log("   -", k.handle, "|", k.title);
  } else {
    console.log("(no combinedListing object)");
  }

  console.log("\n=== METAFIELDS (color/group/variant-related first) ===");
  const mfs = (p.metafields?.edges || []).map(e => e.node);
  const interesting = mfs.filter(m => /colo|group|variant|sibling|related|swatch|style|combine/i.test(`${m.namespace}.${m.key}`));
  for (const m of interesting) {
    console.log(`  ${m.namespace}.${m.key} (${m.type}): ${String(m.value).slice(0, 300)}`);
  }
  console.log(`\n  --- all ${mfs.length} metafield keys ---`);
  console.log("  " + mfs.map(m => `${m.namespace}.${m.key}`).join("\n  "));
}

main().catch(e => { console.error("ERR", e?.response?.errors || e); process.exit(1); });
