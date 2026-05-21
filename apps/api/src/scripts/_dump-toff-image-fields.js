#!/usr/bin/env node
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const accountName = process.env.VTEX_ACCOUNT || "toffro";
const appKey = process.env.VTEX_API_KEY;
const appToken = process.env.VTEX_API_TOKEN;

const BASE = `https://${accountName}.vtexcommercestable.com.br`;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
};

const handle = "valentino-garavani-rochie-candy-couture-7b3vadt01mmd1k";

async function main() {
  // 1) Search API – what we currently use
  const searchRes = await fetch(`${BASE}/api/catalog_system/pub/products/search/${handle}/p`, { headers: HEADERS });
  const [product] = await searchRes.json();
  const item = product.items[0];
  console.log("──[ Search API: items[0].images[0] (raw) ]──────────────────────────");
  console.log(JSON.stringify(item.images[0], null, 2));
  console.log("\n──[ Search API: items[0].images[0..3] – url + label only ]─────────");
  for (const img of item.images) {
    console.log({ imageId: img.imageId, imageLabel: img.imageLabel, imageText: img.imageText, imageTag: img.imageTag, imageUrl: img.imageUrl });
  }

  // 2) Catalog SKU file API (admin) – returns stable file metadata?
  console.log("\n──[ Catalog SKU files API: /api/catalog/pvt/stockkeepingunit/{skuId}/file ]──");
  try {
    const filesRes = await fetch(`${BASE}/api/catalog/pvt/stockkeepingunit/${item.itemId}/file`, { headers: HEADERS });
    if (!filesRes.ok) {
      console.log(`  ${filesRes.status} ${filesRes.statusText}`);
    } else {
      const files = await filesRes.json();
      console.log(JSON.stringify(files, null, 2));
    }
  } catch (e) {
    console.log("  error:", e.message);
  }

  // 3) Try the label-based image route
  // Pattern (legacy): /arquivos/{label}
  if (item.images[0]?.imageLabel) {
    const label = item.images[0].imageLabel;
    const url1 = `https://${accountName}.vteximg.com.br/arquivos/${encodeURIComponent(label)}`;
    const url2 = `https://${accountName}.vteximg.com.br/arquivos/${encodeURIComponent(label)}.jpg`;
    console.log(`\n──[ Probing label-based legacy URLs (HEAD) ]────────────────────────`);
    for (const u of [url1, url2]) {
      try {
        const r = await fetch(u, { method: "HEAD" });
        console.log(`  ${r.status} ${u}`);
      } catch (e) { console.log(`  ERR ${u}: ${e.message}`); }
    }
  }

  // 4) Probe whether the OLD stale URL we found is broken
  const staleOld = "https://toffro.vteximg.com.br/arquivos/ids/590703/7B3VADT01MMD1K-1.jpg?v=639092698948170000";
  const currentNew = item.images[0].imageUrl;
  console.log(`\n──[ HEAD check: old (Neo4j) vs new (VTEX) imageId URLs ]──────────`);
  for (const u of [staleOld, currentNew]) {
    try {
      const r = await fetch(u, { method: "HEAD" });
      console.log(`  ${r.status} ${u}`);
    } catch (e) { console.log(`  ERR ${u}: ${e.message}`); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
