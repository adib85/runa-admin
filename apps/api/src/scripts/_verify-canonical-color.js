#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);
const session = driver.session();

try {
  const r = await session.run(
    `MATCH (:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
     WITH p.canonicalColor AS c, count(*) AS n
     RETURN c, n
     ORDER BY n DESC`,
    { shop: SHOP }
  );

  const rows = r.records.map(rec => ({
    color: rec.get("c"),
    n: rec.get("n").toNumber ? rec.get("n").toNumber() : Number(rec.get("n")),
  }));

  const total = rows.reduce((s, r) => s + r.n, 0);
  const withColor = rows.filter(r => r.color).reduce((s, r) => s + r.n, 0);
  const without = rows.find(r => !r.color)?.n || 0;

  console.log(`Total products: ${total}`);
  console.log(`  with canonicalColor: ${withColor}`);
  console.log(`  without canonicalColor: ${without}\n`);

  for (const row of rows) {
    console.log(`  ${String(row.n).padStart(4)}  ${row.color || "(null)"}`);
  }
} finally {
  await session.close();
  await driver.close();
}
