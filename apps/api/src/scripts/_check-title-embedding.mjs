import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/adrian/Mobile/runa-admin/.env") });
import neo4j from "neo4j-driver";

const SHOP = "bronze-snake-1.myshopify.com";
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
const s = driver.session();
const n = (v) => (v && v.toNumber ? v.toNumber() : v);
try {
  const r = await s.run(
    `MATCH (p:Product {storeId:$shop})
     RETURN count(p) AS total,
            count(p.title) AS withTitle,
            count(p.titleEmbedding) AS withTitleEmb,
            sum(CASE WHEN p.title IS NOT NULL AND p.titleEmbedding IS NULL THEN 1 ELSE 0 END) AS titleNoEmb`,
    { shop: SHOP }
  );
  const rec = r.records[0];
  const total = n(rec.get("total"));
  const withTitle = n(rec.get("withTitle"));
  const withEmb = n(rec.get("withTitleEmb"));
  const titleNoEmb = n(rec.get("titleNoEmb"));
  console.log(`Store: ${SHOP}`);
  console.log(`Total products:                 ${total}`);
  console.log(`With title:                     ${withTitle}  (${((withTitle/total)*100).toFixed(1)}%)`);
  console.log(`With titleEmbedding:            ${withEmb}  (${((withEmb/total)*100).toFixed(1)}%)`);
  console.log(`Have title but NO embedding:    ${titleNoEmb}`);

  // sample embedding dimension + a couple missing-embedding handles
  const dim = await s.run(
    `MATCH (p:Product {storeId:$shop}) WHERE p.titleEmbedding IS NOT NULL
     RETURN p.handle AS handle, size(p.titleEmbedding) AS dim LIMIT 1`, { shop: SHOP });
  if (dim.records.length) console.log(`\nEmbedding dim (sample ${dim.records[0].get("handle")}): ${n(dim.records[0].get("dim"))}`);

  const miss = await s.run(
    `MATCH (p:Product {storeId:$shop}) WHERE p.titleEmbedding IS NULL
     RETURN p.handle AS handle, p.title AS title LIMIT 10`, { shop: SHOP });
  if (miss.records.length) {
    console.log(`\nSample products missing titleEmbedding:`);
    for (const m of miss.records) console.log(`   - ${m.get("handle")} | title=${JSON.stringify(m.get("title"))}`);
  }
} finally {
  await s.close();
  await driver.close();
}
