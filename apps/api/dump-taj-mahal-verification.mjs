// Dump the taj-mahal-fresh-market state from Neo4j to JSON for parallel auditing.
import neo4j from "neo4j-driver";
import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync("/Users/adrian/Mobile/runa-admin/.env","utf8").split("\n")
    .filter(l=>l && !l.startsWith("#") && l.includes("="))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];})
);
const driver = neo4j.driver(env.NEO4J_URI||"neo4j://3.95.143.107:7687", neo4j.auth.basic(env.NEO4J_USER||"neo4j", env.NEO4J_PASSWORD||env.NEO4J_PWD));
const s = driver.session();
const STORE = "quicklly_taj-mahal-fresh-market";
const run = async (q,p={}) => (await s.run(q,p)).records;
const num = v => v?.toNumber ? v.toNumber() : v;
const obj = (r, keys) => Object.fromEntries(keys.map(k => [k, num(r.get(k))]));

const out = {};

try {
  // 1. Counts
  const c = await run(`
    MATCH (st:Store {id:$id})
    OPTIONAL MATCH (st)-[:HAS_PRODUCT]->(p:Product)
    OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
    OPTIONAL MATCH (cat:Category {storeId:$id})
    OPTIONAL MATCH (st)-[:DELIVERS_TO]->(l:Location)
    RETURN count(DISTINCT p) AS products, count(DISTINCT v) AS variants,
           count(DISTINCT cat) AS categories, count(DISTINCT l) AS locations
  `, { id: STORE });
  out.counts = obj(c[0], ["products","variants","categories","locations"]);

  // 2. Embedding + custom-field coverage
  const cov = await run(`
    MATCH (st:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    RETURN count(p) AS total,
           sum(CASE WHEN p.titleEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasTitle,
           sum(CASE WHEN p.contentEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasContent,
           sum(CASE WHEN p.productEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasProduct,
           sum(CASE WHEN p.characteristicsEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasChars,
           sum(CASE WHEN p.brand IS NOT NULL AND p.brand <> '' THEN 1 ELSE 0 END) AS hasBrand,
           sum(CASE WHEN p.pack_size IS NOT NULL AND p.pack_size <> '' THEN 1 ELSE 0 END) AS hasPack,
           sum(CASE WHEN p.aliases_text IS NOT NULL AND p.aliases_text <> '' THEN 1 ELSE 0 END) AS hasAlias,
           sum(CASE WHEN p.subcategory_slug IS NOT NULL THEN 1 ELSE 0 END) AS hasSubcat,
           sum(CASE WHEN p.merchant_slug IS NOT NULL THEN 1 ELSE 0 END) AS hasMerchant
  `, { id: STORE });
  out.coverage = obj(cov[0], ["total","hasTitle","hasContent","hasProduct","hasChars","hasBrand","hasPack","hasAlias","hasSubcat","hasMerchant"]);

  // 3. Subcategory distribution
  const sub = await run(`
    MATCH (st:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    RETURN p.subcategory_name AS subcat, count(p) AS n ORDER BY n DESC
  `, { id: STORE });
  out.bySubcategory = sub.map(r => ({ subcat: r.get("subcat"), n: num(r.get("n")) }));

  // 4. Brand distribution (top 30)
  const brand = await run(`
    MATCH (st:Store {id:$id})-[:HAS_PRODUCT]->(p:Product)
    WHERE p.brand IS NOT NULL AND p.brand <> ''
    RETURN p.brand AS brand, count(p) AS n ORDER BY n DESC LIMIT 30
  `, { id: STORE });
  out.topBrands = brand.map(r => ({ brand: r.get("brand"), n: num(r.get("n")) }));

  // 5. Sample products (3 per subcategory) for qualitative audit
  out.samples = {};
  for (const subRow of sub.slice(0, 10)) {
    const slug = subRow.get("subcat");
    const r = await run(`
      MATCH (p:Product {storeId:$id, subcategory_name:$slug})
      RETURN p.id AS id, p.title AS title, p.price AS price, p.brand AS brand,
             p.pack_size AS pack_size, p.product_type AS product_type,
             p.aliases_text AS aliases
      LIMIT 4
    `, { id: STORE, slug });
    out.samples[slug] = r.map(rec => ({ id: rec.get("id"), title: rec.get("title"), price: rec.get("price"), brand: rec.get("brand"), pack_size: rec.get("pack_size"), product_type: rec.get("product_type"), aliases: rec.get("aliases") }));
  }

  // 6. Chat-shaped search queries (using existing product embeddings as proxies)
  const seedQueries = [
    { label: "basmati rice", seedTitleLike: "basmati" },
    { label: "ghee", seedTitleLike: "ghee" },
    { label: "garam masala", seedTitleLike: "garam masala" },
    { label: "haldi turmeric", seedTitleLike: "turmeric" },
    { label: "paneer", seedTitleLike: "paneer" },
    { label: "atta", seedTitleLike: "atta" },
  ];
  out.demoQueries = [];
  for (const q of seedQueries) {
    const seed = await run(`
      MATCH (p:Product {storeId:$id}) WHERE toLower(p.title) CONTAINS $like
      RETURN p.id AS id, p.title AS title LIMIT 1
    `, { id: STORE, like: q.seedTitleLike });
    if (!seed.length) { out.demoQueries.push({ ...q, error: "no seed product found" }); continue; }
    const qid = seed[0].get("id");
    const top = await run(`
      MATCH (q:Product {id:$qid})
      MATCH (loc:Location {slug:'sunnyvale-ca'})<-[:DELIVERS_TO]-(st:Store)-[:HAS_PRODUCT]->(p:Product)
      WHERE p.titleEmbedding IS NOT NULL AND p.id <> $qid
      WITH p, gds.similarity.cosine(p.titleEmbedding, q.titleEmbedding) AS sim
      RETURN p.title AS title, p.subcategory_name AS subcat, p.price AS price, p.brand AS brand, sim
      ORDER BY sim DESC LIMIT 8
    `, { qid });
    out.demoQueries.push({
      ...q,
      seedTitle: seed[0].get("title"),
      top: top.map(r => ({ title: r.get("title"), subcat: r.get("subcat"), price: r.get("price"), brand: r.get("brand"), sim: r.get("sim") })),
    });
  }

  // 7. Cross-store integrity: counts per store, spot-check bangladesh-fish products
  const otherStores = await run(`
    MATCH (st:Store) WHERE st.id IN ['quicklly_bangladesh-fish-market-and-halal-meat','carrefour_hipermarket']
    OPTIONAL MATCH (st)-[:HAS_PRODUCT]->(p:Product)
    RETURN st.id AS storeId, count(p) AS n
  `);
  out.otherStores = otherStores.map(r => ({ storeId: r.get("storeId"), n: num(r.get("n")) }));

  // 8. Quicklly-id collision check
  const xCheck = await run(`
    MATCH (p:Product) WHERE p.id STARTS WITH 'quicklly_' AND (p.storeId IS NULL OR NOT p.storeId STARTS WITH 'quicklly_')
    RETURN count(p) AS bad
  `);
  out.crossNamespaceBad = num(xCheck[0].get("bad"));

  // 9. Pack-size range health (capped subcats should have lots of range pack_sizes)
  const ranges = await run(`
    MATCH (p:Product {storeId:$id}) WHERE p.pack_size CONTAINS '-'
    RETURN p.title AS title, p.pack_size AS pack_size LIMIT 12
  `, { id: STORE });
  out.packSizeSamples = ranges.map(r => ({ title: r.get("title"), pack_size: r.get("pack_size") }));

  await fs.promises.writeFile("/tmp/taj-mahal-verification.json", JSON.stringify(out, null, 2));
  console.log("Wrote /tmp/taj-mahal-verification.json");
  console.log("\n=== HEADLINE NUMBERS ===");
  console.log("Products:    ", out.counts.products.toLocaleString());
  console.log("Variants:    ", out.counts.variants.toLocaleString());
  console.log("Categories:  ", out.counts.categories);
  console.log("Locations:   ", out.counts.locations);
  console.log("\n=== COVERAGE ===");
  for (const k of ["hasTitle","hasContent","hasProduct","hasChars","hasBrand","hasPack","hasAlias","hasSubcat","hasMerchant"]) {
    console.log(`  ${k.padEnd(15)} ${out.coverage[k].toLocaleString()}/${out.coverage.total.toLocaleString()}`);
  }
  console.log("\n=== TOP 10 BRANDS ===");
  for (const b of out.topBrands.slice(0,10)) console.log(`  ${b.brand.padEnd(25)} ${b.n}`);
  console.log("\n=== TOP 10 SUBCATEGORIES ===");
  for (const s of out.bySubcategory.slice(0,10)) console.log(`  ${s.subcat.padEnd(35)} ${s.n}`);
  console.log("\n=== INTEGRITY ===");
  console.log("  cross-namespace bad records:", out.crossNamespaceBad);
  for (const s of out.otherStores) console.log(`  ${s.storeId}: ${s.n.toLocaleString()} products (should match pre-sync count)`);
} finally { await s.close(); await driver.close(); }
