import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import neo4j from "neo4j-driver";

const drv = neo4j.driver(
  process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
  neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
);
const s = drv.session();
const STORE = "bronze-snake-1.myshopify.com";
const HANDLE = process.argv[2] || "denim-structure-jacket-denim-blue";

const r1 = await s.run(
  `MATCH (p:Product {storeId: $s, handle: $h})
   OPTIONAL MATCH (p)-[:HAS_DEMOGRAPHIC]->(d:Demographic)
   OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category)
   RETURN p.title AS title, p.product_type AS type, p.tags AS tags,
          p.available AS available, p.status AS status,
          p.detectedColor AS color, p.vendor AS vendor,
          collect(DISTINCT d.name) AS demographics,
          collect(DISTINCT c.name) AS categories`,
  { s: STORE, h: HANDLE }
);
const p = r1.records[0];
console.log("── Product: " + HANDLE);
console.log("  title:        ", p.get("title"));
console.log("  product_type: ", p.get("type"));
console.log("  vendor:       ", p.get("vendor"));
console.log("  color:        ", p.get("color"));
console.log("  available:    ", p.get("available"));
console.log("  status:       ", p.get("status"));
console.log("  demographics: ", p.get("demographics"));
console.log("  categories:   ", p.get("categories"));
console.log("  tags:         ", JSON.stringify(p.get("tags")));

const ptype = p.get("type");
const demos = p.get("demographics");
const cats  = p.get("categories");

const r2 = await s.run(
  `MATCH (p:Product {storeId: $s, product_type: $pt})
   RETURN count(p) AS n`,
  { s: STORE, pt: ptype }
);
console.log("\n── How many other products share the SAME product_type ──");
console.log(`  product_type="${ptype}":`, r2.records[0].get("n").toInt());

if (cats.length) {
  const r3 = await s.run(
    `MATCH (p:Product {storeId: $s})-[:HAS_CATEGORY]->(c:Category)
     WHERE c.name IN $cats
     RETURN c.name AS cat, count(DISTINCT p) AS n
     ORDER BY n DESC`,
    { s: STORE, cats }
  );
  console.log("\n── Catalog count per category this product belongs to ──");
  for (const rec of r3.records) console.log(`  ${rec.get("cat")}: ${rec.get("n").toInt()}`);
}

if (demos.length) {
  const r4 = await s.run(
    `MATCH (p:Product {storeId: $s})-[:HAS_DEMOGRAPHIC]->(d:Demographic)
     WHERE d.name IN $demos
     RETURN d.name AS demo, count(DISTINCT p) AS n
     ORDER BY n DESC`,
    { s: STORE, demos }
  );
  console.log("\n── Catalog count per demographic this product belongs to ──");
  for (const rec of r4.records) console.log(`  ${rec.get("demo")}: ${rec.get("n").toInt()}`);
}

const r5 = await s.run(
  `MATCH (p:Product {storeId: $s})
   WHERE (p.product_type CONTAINS 'Jacket' OR p.product_type CONTAINS 'Denim'
       OR ANY(t IN coalesce(p.tags,[]) WHERE toLower(t) CONTAINS 'denim' OR toLower(t) CONTAINS 'jacket'))
     AND p.handle <> $h
   RETURN p.handle AS h, p.title AS t, p.product_type AS pt
   ORDER BY p.handle
   LIMIT 30`,
  { s: STORE, h: HANDLE }
);
console.log(`\n── Up to 30 other 'jacket/denim'-ish products in the catalog ──`);
for (const rec of r5.records) console.log(`  ${rec.get("h").padEnd(45)} [${rec.get("pt") || "no-type"}]  ${rec.get("t")}`);
console.log(`  (showing ${r5.records.length} matches)`);

await s.close();
await drv.close();
