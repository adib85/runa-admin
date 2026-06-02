// Verify the 5 bangladesh-fish products landed in Neo4j with all expected structure.
import neo4j from "neo4j-driver";
import fs from "node:fs";
import path from "node:path";

const envPath = "/Users/adrian/Mobile/runa-admin/.env";
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const URL = env.NEO4J_URI || env.NEO4J_URL || "neo4j://3.95.143.107:7687";
const USER = env.NEO4J_USER || env.NEO4J_USERNAME || "neo4j";
const PWD  = env.NEO4J_PASSWORD || env.NEO4J_PWD;

const driver = neo4j.driver(URL, neo4j.auth.basic(USER, PWD));
const session = driver.session();
const STORE_ID = "quicklly_bangladesh-fish-market-and-halal-meat";

async function run(query, params = {}) {
  const r = await session.run(query, params);
  return r.records;
}

try {
  console.log("=== 1. Store node ===");
  const stores = await run("MATCH (s:Store {id:$id}) RETURN s.id, s.name", { id: STORE_ID });
  if (stores.length === 0) console.log("❌ Store node missing");
  else console.log(`✅ Store: id=${stores[0].get("s.id")} name=${stores[0].get("s.name")}`);

  console.log("\n=== 2. Products + embeddings ===");
  const products = await run(`
    MATCH (s:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    RETURN p.id AS id, p.title AS title, p.price AS price, p.handle AS handle,
           p.brand AS brand, p.pack_size AS pack_size, p.subcategory_slug AS subcat,
           p.merchant_slug AS merchant, p.merchant_storeid AS merchant_storeid,
           (p.titleEmbedding IS NOT NULL)        AS hasTitle,
           (p.contentEmbedding IS NOT NULL)      AS hasContent,
           (p.productEmbedding IS NOT NULL)      AS hasProduct,
           (p.characteristicsEmbedding IS NOT NULL) AS hasChars,
           size(coalesce(p.titleEmbedding,[]))   AS titleDim,
           size(coalesce(p.contentEmbedding,[])) AS contentDim
    ORDER BY p.title
  `, { id: STORE_ID });
  console.log(`Found ${products.length} products linked to store:\n`);
  for (const r of products) {
    const e = ["title","content","product","chars"].map((k,i) => {
      const has = r.get(["hasTitle","hasContent","hasProduct","hasChars"][i]);
      return has ? `${k}✓` : `${k}✗`;
    }).join(" ");
    console.log(`  ${r.get("id")}`);
    console.log(`    title="${r.get("title")}"   price=${r.get("price")}   handle=${r.get("handle")}`);
    console.log(`    brand="${r.get("brand")}"   pack_size="${r.get("pack_size")}"   subcat=${r.get("subcat")}`);
    console.log(`    merchant=${r.get("merchant")} (storeid=${r.get("merchant_storeid")})`);
    console.log(`    embeddings: ${e}   titleDim=${r.get("titleDim")}  contentDim=${r.get("contentDim")}`);
  }

  console.log("\n=== 3. Variants ===");
  const variants = await run(`
    MATCH (s:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)-[:HAS_VARIANT]->(v:Variant)
    RETURN p.id AS pid, v.id AS vid, v.price AS price, v.title AS vtitle
    ORDER BY p.title
  `, { id: STORE_ID });
  for (const r of variants) console.log(`  ${r.get("pid")} → variant ${r.get("vid")} (price ${r.get("price")}, title "${r.get("vtitle")}")`);

  console.log("\n=== 4. Categories (store-namespaced via categoryHierarchy=true) ===");
  const cats = await run(`
    MATCH (c:Category {storeId:$id})
    OPTIONAL MATCH (c)<-[:HAS_CATEGORY]-(p:Product)
    OPTIONAL MATCH (c)-[:CHILD_OF]->(parent:Category)
    RETURN c.slug AS slug, c.name AS name, count(DISTINCT p) AS prodCount,
           collect(DISTINCT parent.slug) AS parents
    ORDER BY c.slug
  `, { id: STORE_ID });
  for (const r of cats) {
    console.log(`  ${r.get("slug")} (name="${r.get("name")}")   products=${r.get("prodCount").toNumber?.() ?? r.get("prodCount")}   parents=${JSON.stringify(r.get("parents"))}`);
  }

  console.log("\n=== 5. Metafield: delivers_to (location fallback) ===");
  const mf = await run(`
    MATCH (s:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    WITH p LIMIT 1
    RETURN p.id AS id, p.metafields AS metafields
  `, { id: STORE_ID });
  if (mf.length) {
    const fields = mf[0].get("metafields");
    if (fields) {
      const ds = (Array.isArray(fields) ? fields : []).find(f => (f.key || "").includes?.("delivers_to") || (typeof f === "string" && f.includes("delivers_to")));
      console.log(`  metafields type=${Array.isArray(fields) ? "array" : typeof fields}, sample first 3:`);
      if (Array.isArray(fields)) for (const f of fields.slice(0,5)) console.log(`    ${JSON.stringify(f)}`);
      else console.log(`    (raw)`, fields);
    } else console.log("  ⚠ metafields not present on product node — check if writer ignores them");
  }

  console.log("\n=== 6. Embedding vector sample (first 3 dims of titleEmbedding) ===");
  const samp = await run(`
    MATCH (s:Store {id:$id})-[:HAS_PRODUCT]->(p:Product) WITH p LIMIT 1
    RETURN p.title AS title, p.titleEmbedding[0..3] AS sample
  `, { id: STORE_ID });
  if (samp.length) console.log(`  "${samp[0].get("title")}" → [${samp[0].get("sample").join(", ")}, ...]`);

  console.log("\n=== 7. Similarity search smoke test ===");
  const sim = await run(`
    MATCH (s:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    WHERE p.titleEmbedding IS NOT NULL
    WITH p, gds.similarity.cosine(p.titleEmbedding, p.titleEmbedding) AS selfSim
    RETURN p.title, selfSim
    ORDER BY p.title LIMIT 3
  `, { id: STORE_ID });
  for (const r of sim) console.log(`  "${r.get("p.title")}"  selfSim=${r.get("selfSim")}`);

  console.log("\n=== summary ===");
  console.log(`Products in store '${STORE_ID}': ${products.length}/5`);
  const allEmbedded = products.every(r => r.get("hasTitle") && r.get("hasContent") && r.get("hasProduct") && r.get("hasChars"));
  console.log(`All 4 embeddings on every product: ${allEmbedded ? "✅" : "❌"}`);
  console.log(`Variants: ${variants.length}/5`);
  console.log(`Category nodes: ${cats.length}`);

} finally {
  await session.close();
  await driver.close();
}
