// Real chat-style search test: OpenAI-embed query strings, cosine-search the Taj
// Mahal catalog. Mirrors EXACTLY what the chat handler will do.
import neo4j from "neo4j-driver";
import OpenAI from "openai";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync("/Users/adrian/Mobile/runa-admin/.env","utf8").split("\n")
    .filter(l=>l && !l.startsWith("#") && l.includes("="))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];})
);

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const driver = neo4j.driver(env.NEO4J_URI||"neo4j://3.95.143.107:7687", neo4j.auth.basic(env.NEO4J_USER||"neo4j", env.NEO4J_PASSWORD||env.NEO4J_PWD));
const s = driver.session();
const STORE = "quicklly_taj-mahal-fresh-market";

async function embed(text) {
  const r = await openai.embeddings.create({ model: "text-embedding-3-small", input: text });
  return r.data[0].embedding;
}

const QUERIES = [
  "basmati rice",
  "ghee",
  "paneer",
  "turmeric powder",
  "haldi",
  "garam masala",
  "atta",
  "biryani masala",
  "chai tea",
  "moong dal",
  "frozen samosa",
  "haldiram bhujia",
];

const out = {};
try {
  for (const q of QUERIES) {
    console.log(`\n=== query: "${q}" ===`);
    const qe = await embed(q);
    // Try the same Cypher the chat will run — location-anchored, embedding cosine.
    const res = await s.run(`
      MATCH (loc:Location {slug:'sunnyvale-ca'})<-[:DELIVERS_TO]-(st:Store)-[:HAS_PRODUCT]->(p:Product)
      WHERE p.titleEmbedding IS NOT NULL
      WITH p, st, gds.similarity.cosine(p.titleEmbedding, $qe) AS sim
      RETURN p.title AS title, p.brand AS brand, p.subcategory_name AS subcat, p.price AS price, sim
      ORDER BY sim DESC LIMIT 8
    `, { qe });
    const top = res.records.map(r => ({
      title: r.get("title"), brand: r.get("brand"), subcat: r.get("subcat"), price: r.get("price"), sim: r.get("sim"),
    }));
    out[q] = top;
    for (const r of top) console.log(`  sim=${r.sim.toFixed(3)}  "${r.title}"  [${r.subcat}] $${r.price} brand=${r.brand||""}`);

    // ALSO try with characteristicsEmbedding (the alias-rich vector)
    const charsRes = await s.run(`
      MATCH (loc:Location {slug:'sunnyvale-ca'})<-[:DELIVERS_TO]-(st:Store)-[:HAS_PRODUCT]->(p:Product)
      WHERE p.characteristicsEmbedding IS NOT NULL
      WITH p, gds.similarity.cosine(p.characteristicsEmbedding, $qe) AS sim
      RETURN p.title AS title, p.subcategory_name AS subcat, sim
      ORDER BY sim DESC LIMIT 5
    `, { qe });
    console.log(`  -- top 5 via characteristicsEmbedding --`);
    for (const r of charsRes.records) console.log(`     sim=${r.get("sim").toFixed(3)}  "${r.get("title")}"  [${r.get("subcat")}]`);

    // AND weighted hybrid (title 0.6, content 0.2, product 0.2)
    const hybridRes = await s.run(`
      MATCH (loc:Location {slug:'sunnyvale-ca'})<-[:DELIVERS_TO]-(st:Store)-[:HAS_PRODUCT]->(p:Product)
      WHERE p.titleEmbedding IS NOT NULL
      WITH p,
           0.5 * gds.similarity.cosine(p.titleEmbedding, $qe) +
           0.3 * gds.similarity.cosine(p.contentEmbedding, $qe) +
           0.2 * gds.similarity.cosine(p.characteristicsEmbedding, $qe) AS sim
      RETURN p.title AS title, p.subcategory_name AS subcat, sim
      ORDER BY sim DESC LIMIT 5
    `, { qe });
    console.log(`  -- top 5 via WEIGHTED HYBRID (title+content+chars) --`);
    for (const r of hybridRes.records) console.log(`     sim=${r.get("sim").toFixed(3)}  "${r.get("title")}"  [${r.get("subcat")}]`);
  }
  await fs.promises.writeFile("/tmp/real-chat-search-results.json", JSON.stringify(out, null, 2));
  console.log("\nWrote /tmp/real-chat-search-results.json");
} finally { await s.close(); await driver.close(); }
