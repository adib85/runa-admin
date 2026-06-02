import neo4j from "neo4j-driver";
import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync("/Users/adrian/Mobile/runa-admin/.env","utf8").split("\n")
    .filter(l=>l && !l.startsWith("#") && l.includes("="))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];})
);
const driver = neo4j.driver(env.NEO4J_URI||"neo4j://3.95.143.107:7687", neo4j.auth.basic(env.NEO4J_USER||"neo4j", env.NEO4J_PASSWORD||env.NEO4J_PWD));
const s = driver.session();
const STORE = "quicklly_bangladesh-fish-market-and-halal-meat";
const run = async (q,p={}) => (await s.run(q,p)).records;
const num = v => v?.toNumber ? v.toNumber() : v;

try {
  const counts = await run(`
    MATCH (st:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
    OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category {storeId:$id})
    OPTIONAL MATCH (st)-[:DELIVERS_TO]->(l:Location)
    RETURN count(DISTINCT p) AS products, count(DISTINCT v) AS variants,
           count(DISTINCT c) AS categories, count(DISTINCT l) AS deliveryLocations
  `, { id: STORE });
  const r = counts[0];
  console.log(`Products:          ${num(r.get("products"))}`);
  console.log(`Variants:          ${num(r.get("variants"))}`);
  console.log(`Categories:        ${num(r.get("categories"))}`);
  console.log(`Delivery edges:    ${num(r.get("deliveryLocations"))}`);

  const embedding = await run(`
    MATCH (st:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    RETURN count(p) AS total,
           sum(CASE WHEN p.titleEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasTitle,
           sum(CASE WHEN p.contentEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasContent,
           sum(CASE WHEN p.productEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasProduct,
           sum(CASE WHEN p.characteristicsEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasChars,
           sum(CASE WHEN p.aliases_text IS NOT NULL AND p.aliases_text <> '' THEN 1 ELSE 0 END) AS hasAliases,
           sum(CASE WHEN p.subcategory_slug IS NOT NULL THEN 1 ELSE 0 END) AS hasSubcat,
           sum(CASE WHEN p.merchant_slug IS NOT NULL THEN 1 ELSE 0 END) AS hasMerchant,
           sum(CASE WHEN p.pack_size IS NOT NULL AND p.pack_size <> '' THEN 1 ELSE 0 END) AS hasPackSize
  `, { id: STORE });
  const e = embedding[0];
  const t = num(e.get("total"));
  console.log(`\n=== Embedding + custom-field coverage (out of ${t}) ===`);
  console.log(`  titleEmbedding:   ${num(e.get("hasTitle"))}/${t}`);
  console.log(`  contentEmbedding: ${num(e.get("hasContent"))}/${t}`);
  console.log(`  productEmbedding: ${num(e.get("hasProduct"))}/${t}`);
  console.log(`  characteristics:  ${num(e.get("hasChars"))}/${t}`);
  console.log(`  aliases_text:     ${num(e.get("hasAliases"))}/${t}`);
  console.log(`  subcategory_slug: ${num(e.get("hasSubcat"))}/${t}`);
  console.log(`  merchant_slug:    ${num(e.get("hasMerchant"))}/${t}`);
  console.log(`  pack_size set:    ${num(e.get("hasPackSize"))}/${t}`);

  console.log(`\n=== Products by subcategory ===`);
  const bySubcat = await run(`
    MATCH (st:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    RETURN p.subcategory_name AS subcat, count(p) AS n ORDER BY n DESC
  `, { id: STORE });
  for (const r of bySubcat) console.log(`  ${r.get("subcat")}: ${num(r.get("n"))}`);

  console.log(`\n=== Chat-shaped demo query: 'fish' in manhattan-ny (top 5 by titleEmbedding cosine to first hilsha product) ===`);
  const seedHilsha = await run(`
    MATCH (p:Product {storeId:$id}) WHERE toLower(p.title) CONTAINS 'hilsha' RETURN p.id AS id LIMIT 1
  `, { id: STORE });
  if (seedHilsha.length) {
    const qid = seedHilsha[0].get("id");
    const top = await run(`
      MATCH (q:Product {id:$qid})
      MATCH (loc:Location {slug:'manhattan-ny'})<-[:DELIVERS_TO]-(s:Store)-[:HAS_PRODUCT]->(p:Product)
      WHERE p.titleEmbedding IS NOT NULL AND p.id <> $qid
      WITH p, gds.similarity.cosine(p.titleEmbedding, q.titleEmbedding) AS sim
      RETURN p.title AS title, p.subcategory_name AS subcat, p.price AS price, sim
      ORDER BY sim DESC LIMIT 5
    `, { qid });
    console.log(`  (seed: ${qid})`);
    for (const r of top) console.log(`  sim=${r.get("sim").toFixed(3)}  "${r.get("title")}"  [${r.get("subcat")}]  $${r.get("price")}`);
  }

  console.log(`\n=== Chat-shaped demo query: 'keema' query (using Beef Keema's embedding) ===`);
  const seedKeema = await run(`MATCH (p:Product {storeId:$id}) WHERE toLower(p.title) = 'beef keema' RETURN p.id AS id LIMIT 1`, { id: STORE });
  if (seedKeema.length) {
    const qid = seedKeema[0].get("id");
    const top = await run(`
      MATCH (q:Product {id:$qid})
      MATCH (loc:Location {slug:'manhattan-ny'})<-[:DELIVERS_TO]-(s:Store)-[:HAS_PRODUCT]->(p:Product)
      WHERE p.titleEmbedding IS NOT NULL AND p.id <> $qid
      WITH p, gds.similarity.cosine(p.titleEmbedding, q.titleEmbedding) AS sim
      RETURN p.title AS title, p.subcategory_name AS subcat, p.price AS price, sim
      ORDER BY sim DESC LIMIT 5
    `, { qid });
    for (const r of top) console.log(`  sim=${r.get("sim").toFixed(3)}  "${r.get("title")}"  [${r.get("subcat")}]  $${r.get("price")}`);
  }

  console.log(`\n=== Pack-size verification on the range products ===`);
  const ranges = await run(`
    MATCH (p:Product {storeId:$id})
    WHERE p.pack_size IS NOT NULL AND p.pack_size CONTAINS '-'
    RETURN p.title AS title, p.pack_size AS pack_size ORDER BY p.title
  `, { id: STORE });
  for (const r of ranges) console.log(`  "${r.get("title")}" → pack_size="${r.get("pack_size")}"`);

} finally {
  await s.close();
  await driver.close();
}
