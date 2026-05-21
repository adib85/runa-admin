import dotenv from "dotenv";
dotenv.config({ path: "/Users/adrian/Mobile/runa-admin/.env" });
import neo4j from "neo4j-driver";

const driver = neo4j.driver(
  process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
  neo4j.auth.basic(process.env.NEO4J_USER || "neo4j", process.env.NEO4J_PASSWORD)
);
const STORE = "bronze-snake-1.myshopify.com";

const queries = [
  ["Total products with handle",            null],
  ["Step 2 missing (CTL gen)",              "p.complete_the_look_updated_at IS NULL"],
  ["Step 3 missing (Similar gen)",          "p.similar_product_updated_at IS NULL"],
  ["Step 4 missing (Ask AI gen)",           "p.ask_ai_options_updated_at IS NULL"],
  ["Step 5 missing (CTL writer)",           "p.ctl_metafield_synced_at IS NULL"],
  ["Step 6 missing (Similar writer)",       "p.similar_metafield_synced_at IS NULL"],
  ["Step 7 missing (Ask AI writer)",        "p.ask_ai_metafield_synced_at IS NULL"],
  ["Step 8 missing (Hero image writer)",    "p.hero_image_metafield_synced_at IS NULL"],
];

const session = driver.session();
console.log(`\nMissing-product counts for ${STORE}\n`);
for (const [label, filter] of queries) {
  const where = filter ? `AND ${filter}` : "";
  const r = await session.run(
    `MATCH (p:Product)
     WHERE p.storeId = $s
       AND p.handle IS NOT NULL AND p.handle <> ''
       ${where}
     RETURN count(p) AS n`,
    { s: STORE }
  );
  const n = r.records[0].get("n").toInt();
  console.log(`  ${label.padEnd(40)} ${n.toString().padStart(6)}`);
}
console.log("");
await session.close();
await driver.close();
