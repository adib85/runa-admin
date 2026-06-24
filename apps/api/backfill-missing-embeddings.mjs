// Find Quicklly products missing embeddings and re-embed them from their stored text.
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

async function embed(text) {
  const r = await openai.embeddings.create({ model: "text-embedding-3-small", input: text || "unknown" });
  return r.data[0].embedding;
}

try {
  const res = await s.run(`
    MATCH (st:Store)-[:HAS_PRODUCT]->(p:Product)
    WHERE st.id STARTS WITH 'quicklly_'
      AND (p.titleEmbedding IS NULL OR p.contentEmbedding IS NULL
           OR p.productEmbedding IS NULL OR p.characteristicsEmbedding IS NULL)
    RETURN p.id AS id, p.title AS title, p.content AS content,
           p.product AS product, p.characteristics AS characteristics,
           p.subcategory_name AS subcat, p.aliases_text AS aliases
  `);
  console.log(`Found ${res.records.length} Quicklly products missing ≥1 embedding`);
  if (res.records.length === 0) { console.log("Nothing to backfill — all embeddings present."); }

  for (const rec of res.records) {
    const id = rec.get("id");
    const title = rec.get("title") || "";
    const content = rec.get("content") || title;
    const product = rec.get("product") || rec.get("subcat") || title;
    const characteristics = rec.get("characteristics") || [title, rec.get("aliases")].filter(Boolean).join(", ");
    console.log(`  re-embedding ${id} — "${title}"`);
    const [tE, cE, pE, chE] = await Promise.all([
      embed(title), embed(content), embed(product), embed(characteristics),
    ]);
    await s.run(`
      MATCH (p:Product {id:$id})
      SET p.titleEmbedding = $tE, p.contentEmbedding = $cE,
          p.productEmbedding = $pE, p.characteristicsEmbedding = $chE,
          p.updated_at = $now
    `, { id, tE, cE, pE, chE, now: new Date().toISOString() });
  }

  // verify
  const after = await s.run(`
    MATCH (st:Store)-[:HAS_PRODUCT]->(p:Product)
    WHERE st.id STARTS WITH 'quicklly_'
    RETURN count(p) AS total,
           sum(CASE WHEN p.titleEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasTitle,
           sum(CASE WHEN p.contentEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasContent,
           sum(CASE WHEN p.productEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasProduct,
           sum(CASE WHEN p.characteristicsEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS hasChars
  `);
  const a = after.records[0];
  const n = v => v.toNumber();
  console.log(`\n=== After backfill (out of ${n(a.get("total"))} Quicklly products) ===`);
  console.log(`  titleEmbedding:   ${n(a.get("hasTitle"))}`);
  console.log(`  contentEmbedding: ${n(a.get("hasContent"))}`);
  console.log(`  productEmbedding: ${n(a.get("hasProduct"))}`);
  console.log(`  characteristics:  ${n(a.get("hasChars"))}`);
} finally {
  await s.close();
  await driver.close();
}
