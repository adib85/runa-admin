// Verify the v2 schema (added :Location, :DELIVERS_TO + custom Product fields).
import neo4j from "neo4j-driver";
import fs from "node:fs";

const envPath = "/Users/adrian/Mobile/runa-admin/.env";
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const URL = env.NEO4J_URI || env.NEO4J_URL || "neo4j://3.95.143.107:7687";
const driver = neo4j.driver(URL, neo4j.auth.basic(env.NEO4J_USER || "neo4j", env.NEO4J_PASSWORD || env.NEO4J_PWD));
const session = driver.session();
const STORE_ID = "quicklly_bangladesh-fish-market-and-halal-meat";

async function run(query, params = {}) {
  const r = await session.run(query, params);
  return r.records;
}
const num = v => v?.toNumber ? v.toNumber() : v;

try {
  console.log("=== 1. Custom Product fields (now populated?) ===");
  const products = await run(`
    MATCH (s:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    RETURN p.id AS id, p.title AS title, p.brand AS brand, p.pack_size AS pack_size,
           p.product_type AS product_type, p.subcategory_slug AS subcat, p.subcategory_name AS subcatName,
           p.merchant_slug AS merchant, p.merchant_storeid AS merchant_storeid,
           p.aliases_text AS aliases, p.title_normalized AS title_norm
    ORDER BY p.title
  `, { id: STORE_ID });
  for (const r of products) {
    console.log(`  ${r.get("id")}`);
    console.log(`    title="${r.get("title")}"   brand="${r.get("brand")}"   pack_size="${r.get("pack_size")}"`);
    console.log(`    product_type="${r.get("product_type")}"`);
    console.log(`    subcat=${r.get("subcat")} ("${r.get("subcatName")}")   merchant=${r.get("merchant")} (storeid=${r.get("merchant_storeid")})`);
    console.log(`    title_normalized="${r.get("title_norm")}"`);
    console.log(`    aliases="${r.get("aliases")}"`);
  }

  console.log("\n=== 2. :Location nodes ===");
  const locs = await run(`MATCH (l:Location) RETURN l.slug AS slug, l.city AS city, l.state AS state ORDER BY l.slug`);
  console.log(`Total :Location nodes: ${locs.length}`);
  for (const r of locs.slice(0, 10)) console.log(`  ${r.get("slug")}  → city="${r.get("city")}" state=${r.get("state")}`);
  if (locs.length > 10) console.log(`  ... +${locs.length - 10} more`);

  console.log("\n=== 3. (:Store)-[:DELIVERS_TO]->(:Location) edges for this merchant ===");
  const edges = await run(`
    MATCH (s:Store {id:$id})-[:DELIVERS_TO]->(l:Location)
    RETURN l.slug AS slug ORDER BY l.slug
  `, { id: STORE_ID });
  console.log(`${edges.length} delivery edges from this store:`);
  for (const r of edges) console.log(`  → ${r.get("slug")}`);

  console.log("\n=== 4. THE DEMO QUERY — products in manhattan-ny ===");
  const demo = await run(`
    MATCH (loc:Location {slug:'manhattan-ny'})<-[:DELIVERS_TO]-(s:Store)
          -[:HAS_PRODUCT]->(p:Product)
    RETURN p.title AS title, p.price AS price, p.brand AS brand, p.pack_size AS pack_size,
           p.subcategory_name AS subcat, s.id AS merchant
    ORDER BY p.title
  `);
  console.log(`Products deliverable to manhattan-ny: ${demo.length}`);
  for (const r of demo.slice(0, 8)) {
    console.log(`  ${r.get("title")}  [${r.get("subcat")}]  ${r.get("price")}  via ${r.get("merchant")}`);
  }

  console.log("\n=== 5. Embedding similarity demo — chat-style 'goat' query ===");
  // Pick the Beef Keema's embedding and search across the store as a stand-in
  // (the real chat would use an OpenAI-embedded user query — same Cypher).
  const sim = await run(`
    MATCH (q:Product {id:$qid})
    MATCH (loc:Location {slug:'manhattan-ny'})<-[:DELIVERS_TO]-(s:Store)
          -[:HAS_PRODUCT]->(p:Product)
    WHERE p.titleEmbedding IS NOT NULL AND p.id <> $qid
    WITH p, s, gds.similarity.cosine(p.titleEmbedding, q.titleEmbedding) AS sim
    RETURN p.title AS title, p.price AS price, p.subcategory_name AS subcat, s.id AS merchant, sim
    ORDER BY sim DESC LIMIT 5
  `, { qid: `${STORE_ID}-227150` /* Beef Keema */ });
  console.log("Query embedding source: 'Beef Keema'");
  console.log("Top-5 similar products in manhattan-ny:");
  for (const r of sim) console.log(`  sim=${r.get("sim").toFixed(3)}  ${r.get("title")}  [${r.get("subcat")}]  $${r.get("price")}`);

  console.log("\n=== summary ===");
  const allBrandFieldsSet = products.every(r => r.get("subcategory_slug") !== undefined && r.get("merchant") !== null);
  console.log(`Custom fields landed: ${products.length === 5 && products[0].get("merchant") !== null ? "✅" : "❌"}`);
  console.log(`:Location nodes:      ${locs.length > 0 ? "✅ (" + locs.length + ")" : "❌"}`);
  console.log(`:DELIVERS_TO edges:   ${edges.length > 0 ? "✅ (" + edges.length + ")" : "❌"}`);
  console.log(`Demo location query:  ${demo.length > 0 ? "✅ (" + demo.length + " products via manhattan-ny)" : "❌"}`);
  console.log(`Similarity search:    ${sim.length > 0 ? "✅" : "❌"}`);

} finally {
  await session.close();
  await driver.close();
}
