import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/adrian/Mobile/runa-admin/.env") });
import neo4j from "neo4j-driver";

const SHOP = "bronze-snake-1.myshopify.com";
const HANDLE = process.argv[2] || "collar-lined-jacket-black";

const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
const s = driver.session();
try {
  const r = await s.run(
    `MATCH (p:Product {handle: $h, storeId: $shop})
     OPTIONAL MATCH (p)-[:RELATED_COLOURWAY]-(o:Product)
     RETURN p.handle AS handle, p.related_colourways AS prop,
            collect({handle: o.handle, color: o.canonicalColor, id: o.id}) AS siblings`,
    { h: HANDLE, shop: SHOP }
  );
  const rec = r.records[0];
  console.log("product:", rec.get("handle"));
  console.log("property related_colourways:", JSON.stringify(rec.get("prop")));
  console.log("edge-linked siblings:");
  for (const sib of rec.get("siblings")) {
    if (sib.handle) console.log(`   - ${sib.handle} | ${sib.color} | ${sib.id}`);
  }

  const tot = await s.run(`MATCH (:Product {storeId:$shop})-[r:RELATED_COLOURWAY]->(:Product {storeId:$shop}) RETURN count(r) AS c`, { shop: SHOP });
  console.log("\ntotal RELATED_COLOURWAY edges (directed):", tot.records[0].get("c").toNumber());

  const withProp = await s.run(`MATCH (p:Product {storeId:$shop}) WHERE p.related_colourways IS NOT NULL AND size(p.related_colourways) > 0 RETURN count(p) AS c`, { shop: SHOP });
  console.log("products with non-empty related_colourways property:", withProp.records[0].get("c").toNumber());
} finally {
  await s.close();
  await driver.close();
}
