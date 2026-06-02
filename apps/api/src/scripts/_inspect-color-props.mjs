import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/adrian/Mobile/runa-admin/.env") });
import neo4j from "neo4j-driver";

const SHOP = "bronze-snake-1.myshopify.com";
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
const s = driver.session();
try {
  const r = await s.run(
    `MATCH (p:Product {storeId:$shop})
     WHERE p.handle IN ['collar-lined-jacket-black','collar-lined-jacket-dark-brown','collar-lined-jacket-khaki']
     RETURN p.id AS id, p.handle AS handle, p.title AS title,
            p.canonicalColor AS canonicalColor, p.color AS color,
            p.related_colourways AS related_colourways,
            (p.colorEmbedding IS NOT NULL) AS hasColorEmbedding`,
    { shop: SHOP }
  );
  for (const rec of r.records) {
    console.log(JSON.stringify(rec.toObject(), null, 2));
  }
} finally {
  await s.close();
  await driver.close();
}
