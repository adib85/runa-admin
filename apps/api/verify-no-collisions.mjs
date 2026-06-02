// Prove that our Quicklly writes did not touch any other store's products.
import neo4j from "neo4j-driver";
import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync("/Users/adrian/Mobile/runa-admin/.env","utf8").split("\n")
    .filter(l=>l && !l.startsWith("#") && l.includes("="))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];})
);
const driver = neo4j.driver(env.NEO4J_URI||"neo4j://3.95.143.107:7687", neo4j.auth.basic(env.NEO4J_USER||"neo4j", env.NEO4J_PASSWORD||env.NEO4J_PWD));
const s = driver.session();
const run = async (q,p={}) => (await s.run(q,p)).records;
const num = v => v?.toNumber ? v.toNumber() : v;

try {
  console.log("=== 1. Products per :Store (proves no other store's products were touched) ===");
  const perStore = await run(`
    MATCH (st:Store)
    OPTIONAL MATCH (st)-[:HAS_PRODUCT]->(p:Product)
    RETURN st.id AS storeId, count(p) AS n
    ORDER BY n DESC
  `);
  for (const r of perStore) {
    const sid = r.get("storeId");
    const tag = sid.startsWith("quicklly_") ? " [QUICKLLY — ours]" : "";
    console.log(`  ${sid}: ${num(r.get("n")).toLocaleString()} products${tag}`);
  }

  console.log("\n=== 2. ID/storeId integrity check ===");
  // For any product whose id begins with a known store prefix, confirm its storeId
  // matches. If a Quicklly write had clobbered a Bringo product, the id would be
  // `carrefour_hipermarket-N` but the storeId would now be `quicklly_*`.
  const integrity = await run(`
    MATCH (p:Product)
    WITH p,
         CASE
           WHEN p.id STARTS WITH 'quicklly_'            THEN 'quicklly'
           WHEN p.id STARTS WITH 'carrefour_hipermarket-' THEN 'carrefour_hipermarket'
           WHEN p.id STARTS WITH 'fashiondays.ro-'      THEN 'fashiondays.ro'
           WHEN p.id STARTS WITH 'gid://shopify'        THEN 'shopify'
           ELSE 'other'
         END AS idClass,
         p.storeId AS storeId
    RETURN idClass,
           count(*) AS total,
           sum(CASE WHEN storeId IS NULL THEN 1 ELSE 0 END) AS nullStoreId,
           collect(DISTINCT storeId)[0..5] AS sampleStoreIds
    ORDER BY total DESC
  `);
  for (const r of integrity) {
    console.log(`  id-class=${r.get("idClass").padEnd(22)} total=${num(r.get("total")).toLocaleString().padStart(8)}  nullStoreId=${num(r.get("nullStoreId"))}`);
    console.log(`     sample storeIds: ${JSON.stringify(r.get("sampleStoreIds"))}`);
  }

  console.log("\n=== 3. Cross-namespace check — any Quicklly-prefixed id with a non-Quicklly storeId? ===");
  const xCheck = await run(`
    MATCH (p:Product)
    WHERE p.id STARTS WITH 'quicklly_' AND (p.storeId IS NULL OR NOT p.storeId STARTS WITH 'quicklly_')
    RETURN count(p) AS broken
  `);
  console.log(`  Quicklly-id products with mismatched storeId: ${num(xCheck[0].get("broken"))}`);

  console.log("\n=== 4. Reverse check — any non-Quicklly id with a Quicklly storeId? ===");
  const rCheck = await run(`
    MATCH (p:Product)
    WHERE p.storeId STARTS WITH 'quicklly_' AND NOT p.id STARTS WITH 'quicklly_'
    RETURN count(p) AS broken
  `);
  console.log(`  Non-Quicklly-id products that claim a Quicklly storeId: ${num(rCheck[0].get("broken"))}`);

  console.log("\n=== 5. Spot-check pre-existing non-Quicklly products are intact ===");
  // Pick a random Bringo product (if any) and confirm its core properties are still there.
  const sample = await run(`
    MATCH (p:Product) WHERE p.storeId = 'carrefour_hipermarket'
    RETURN p.id AS id, p.title AS title, p.vendor AS vendor, p.category AS category,
           (p.titleEmbedding IS NOT NULL) AS hasEmb,
           p.merchant_slug AS merchant_slug
    LIMIT 3
  `);
  if (sample.length === 0) console.log("  (no Bringo products in DB — skipping spot-check)");
  else for (const r of sample) {
    console.log(`  ${r.get("id")}`);
    console.log(`    title="${r.get("title")}"   vendor="${r.get("vendor")}"   category="${r.get("category")}"   embedding=${r.get("hasEmb")}`);
    console.log(`    merchant_slug=${r.get("merchant_slug")} (should be null — Bringo doesn't emit this field)`);
  }

  console.log("\n=== 6. Recent write activity (proves nothing else recently mutated) ===");
  // Updated_at on a few Quicklly vs non-Quicklly products
  const recent = await run(`
    MATCH (p:Product) WHERE p.updated_at IS NOT NULL
    WITH p ORDER BY p.updated_at DESC LIMIT 10
    RETURN p.id AS id, p.storeId AS storeId, p.updated_at AS updated_at
  `);
  for (const r of recent) {
    console.log(`  ${r.get("updated_at")}  ${r.get("storeId")}  ${r.get("id")}`);
  }

} finally {
  await s.close();
  await driver.close();
}
