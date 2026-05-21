import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import neo4j from "neo4j-driver";

const STORE = "bronze-snake-1.myshopify.com";
const HANDLE = process.argv[2] || "lyra-denim-halter-white";
const FIELD  = process.argv[3] || "similar_product_updated_at";

const driver = neo4j.driver(
  process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
  neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
);
const session = driver.session();
const r = await session.run(
  `MATCH (p:Product {storeId: $storeId, handle: $handle})
   SET p.${FIELD} = datetime(),
       p.${FIELD.replace(/_updated_at$|_synced_at$/, "")}_skipped_reason = "lambda HTTP 502 — needs investigation"
   RETURN p.id AS id, p.title AS title, p.${FIELD} AS stamped`,
  { storeId: STORE, handle: HANDLE }
);
if (r.records.length === 0) console.log(`Product not found: ${HANDLE}`);
else {
  const rec = r.records[0];
  console.log(`Stamped ${FIELD} on "${rec.get("title")}" (${rec.get("id")}) → ${rec.get("stamped")}`);
}
await session.close();
await driver.close();
