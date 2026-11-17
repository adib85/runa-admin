#!/usr/bin/env node
/**
 * Seed the Xpert Beauty routine ontology into Neo4j (idempotent, additive, store-scoped):
 *   (:Routine {storeId, key, name_ro, family, priority, heroCue, requireCue, heroCategories})
 *     -[:HAS_STEP]-> (:RoutineStep {storeId, key, order, optional, productHint, characteristics,
 *                                   forbidTokens, skipIfHeroMatches, matchHeroType, pickOtherFormat})
 *     -[:COMPLEMENTS {rank}]-> (:Category {storeId, name})   // existing store category nodes only
 * Re-running replaces the routine's steps (so config edits apply cleanly).
 *   node src/scripts/seed-xpertbeauty-routines.mjs [--dry-run]
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");
const { ROUTINES } = await import("../graph/xpertbeauty-routines.config.mjs");
const STORE = "xpertbeauty.ro"; const DRY = process.argv.includes("--dry-run");
const svc = new Neo4jService(); const driver = svc.getDriver(); const s = driver.session();
try {
  // sanity: every referenced category must exist as a store-scoped node
  const names = [...new Set(ROUTINES.flatMap(r => [...r.heroCategories, ...r.steps.flatMap(st => st.categories)]))];
  const res = await s.run(`UNWIND $names AS n OPTIONAL MATCH (c:Category {storeId:$s, name:n}) RETURN n, c IS NOT NULL AS ok`, { names, s: STORE });
  const missing = res.records.filter(r => !r.get("ok")).map(r => r.get("n"));
  if (missing.length) console.warn("⚠ categories not in graph (steps referencing them will simply have no candidates):", missing.join(" | "));
  if (DRY) { console.log(`[dry-run] ${ROUTINES.length} routines, ${ROUTINES.reduce((a, r) => a + r.steps.length, 0)} steps`); process.exit(0); }
  let steps = 0, links = 0;
  for (const r of ROUTINES) {
    await s.run(`MERGE (rt:Routine {storeId:$s, key:$key})
      SET rt.name_ro=$name_ro, rt.family=$family, rt.priority=$priority, rt.heroCue=$heroCue, rt.excludeCue=$excludeCue, rt.requireCue=$requireCue, rt.heroCategories=$heroCategories, rt.updatedAt=datetime()
      WITH rt OPTIONAL MATCH (rt)-[:HAS_STEP]->(old:RoutineStep) DETACH DELETE old`,
      { s: STORE, key: r.key, name_ro: r.name_ro, family: r.family, priority: r.priority, heroCue: r.heroCue || null, excludeCue: r.excludeCue || null, requireCue: !!r.requireCue, heroCategories: r.heroCategories });
    for (const st of r.steps) {
      const out = await s.run(`MATCH (rt:Routine {storeId:$s, key:$key})
        CREATE (rt)-[:HAS_STEP]->(st:RoutineStep {storeId:$s, key:$skey, order:$order, optional:$optional, productHint:$productHint, characteristics:$characteristics, forbidTokens:$forbidTokens, skipIfHeroMatches:$skip, matchHeroType:$matchHeroType, pickOtherFormat:$pickOtherFormat})
        WITH st UNWIND range(0, size($cats)-1) AS i
        MATCH (c:Category {storeId:$s, name:$cats[i]}) MERGE (st)-[l:COMPLEMENTS]->(c) SET l.rank = i
        RETURN count(l) AS n`,
        { s: STORE, key: r.key, skey: `${r.key}#${st.order}`, order: st.order, optional: !!st.optional, productHint: st.productHint || null, characteristics: st.characteristics || null,
          forbidTokens: st.forbidTokens || null, skip: st.skipIfHeroMatches || null, matchHeroType: !!st.matchHeroType, pickOtherFormat: !!st.pickOtherFormat, cats: st.categories });
      steps++; links += out.records[0].get("n").toNumber();
    }
  }
  console.log(`seeded ${ROUTINES.length} routines, ${steps} steps, ${links} COMPLEMENTS links`);
} finally { await s.close(); await driver.close(); }
