#!/usr/bin/env node
/**
 * One-shot fix: re-case existing Bronze Snake canonicalColor values to the
 * 33-color canonical proper-case form. Safe to re-run.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { normalizeCanonicalColor } from "../sync/services/detect-canonical-color.js";

const SHOP = "bronze-snake-1.myshopify.com";

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);
const session = driver.session();

try {
  const r = await session.run(
    `MATCH (:Store {id: $shop})-[:HAS_PRODUCT]->(p:Product)
     WHERE p.canonicalColor IS NOT NULL
     RETURN p.id AS id, p.canonicalColor AS color`,
    { shop: SHOP }
  );

  const updates = [];
  for (const rec of r.records) {
    const current = rec.get("color");
    const normalized = normalizeCanonicalColor(current);
    if (normalized !== current) {
      updates.push({ id: rec.get("id"), color: normalized });
    }
  }

  console.log(`Found ${updates.length} rows needing recasing.`);
  if (updates.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  for (const u of updates.slice(0, 20)) {
    console.log(`  ${u.id}  → ${u.color}`);
  }

  await session.executeWrite(tx => tx.run(
    `UNWIND $rows AS row
     MATCH (p:Product {id: row.id})
     SET p.canonicalColor = row.color`,
    { rows: updates }
  ));
  console.log(`\n✓ Updated ${updates.length} rows.`);
} finally {
  await session.close();
  await driver.close();
}
