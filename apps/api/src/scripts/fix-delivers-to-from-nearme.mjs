#!/usr/bin/env node
/**
 * Remediate DELIVERS_TO under-coverage using Quicklly's authoritative per-city store
 * lists (the near-me pages cached by audit-delivers-to.mjs under /tmp/nearme).
 *
 * For each of OUR :Location nodes, read Quicklly's near-me page, and MERGE any
 * (:Store)-[:DELIVERS_TO]->(:Location) edge that Quicklly lists but we're missing —
 * but ONLY for stores already in our index (skip not-yet-indexed ones). ADD-ONLY:
 * never removes our existing edges (Quicklly's near-me page caps big cities, so an
 * "extra" on our side is usually a display cap, not a real removal).
 *
 * Usage: node fix-delivers-to-from-nearme.mjs [--dry-run]
 */
import neo4j from "neo4j-driver";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRY = process.argv.includes("--dry-run");
const CACHE = "/tmp/nearme";
const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, "utf8").split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const session = driver.session();
const num = v => v?.toNumber?.() ?? v;
const nowIso = new Date().toISOString();

try {
  // indexed quicklly store slugs
  const sres = await session.run(`MATCH (st:Store) WHERE st.id STARTS WITH 'quicklly_' RETURN replace(st.id,'quicklly_','') AS slug`);
  const indexed = new Set(sres.records.map(r => r.get("slug")));
  // our existing edges: location -> set(store)
  const eres = await session.run(`MATCH (st:Store)-[:DELIVERS_TO]->(l:Location) WHERE st.id STARTS WITH 'quicklly_' RETURN l.slug AS loc, collect(replace(st.id,'quicklly_','')) AS stores`);
  const ours = new Map(eres.records.map(r => [r.get("loc"), new Set(r.get("stores"))]));
  // our locations
  const lres = await session.run(`MATCH (l:Location) RETURN l.slug AS slug`);
  const locSlugs = lres.records.map(r => r.get("slug")).filter(s => s && /^[a-z0-9-]+$/.test(s));

  const toAdd = []; // {store, loc}
  let skippedNotIndexed = new Set();
  for (const slug of locSlugs) {
    let html; try { html = fs.readFileSync(path.join(CACHE, slug + ".html"), "utf8"); } catch { continue; }
    const theirs = new Set();
    const re = new RegExp(`indian-grocery-store/${slug}/([a-z0-9-]+)`, "g");
    let m; while ((m = re.exec(html)) !== null) theirs.add(m[1]);
    const have = ours.get(slug) || new Set();
    for (const store of theirs) {
      if (have.has(store)) continue;
      if (!indexed.has(store)) { skippedNotIndexed.add(store); continue; }
      toAdd.push({ store, loc: slug });
    }
  }

  console.log(`Edges to add: ${toAdd.length} (across ${new Set(toAdd.map(e => e.loc)).size} locations)`);
  console.log(`Skipped (store not in our index): ${[...skippedNotIndexed].join(", ") || "none"}`);
  if (DRY) { console.log("[dry-run] not writing. Sample:"); toAdd.slice(0, 15).forEach(e => console.log(`  ${e.store} -> ${e.loc}`)); }
  else if (toAdd.length) {
    const CHUNK = 500;
    for (let i = 0; i < toAdd.length; i += CHUNK) {
      await session.run(
        `UNWIND $batch AS e
         MATCH (st:Store {id:'quicklly_'+e.store}) MATCH (l:Location {slug:e.loc})
         MERGE (st)-[r:DELIVERS_TO]->(l) ON CREATE SET r.lastSeenAt = $now`,
        { batch: toAdd.slice(i, i + CHUNK), now: nowIso }
      );
    }
    console.log(`✓ Added ${toAdd.length} DELIVERS_TO edges.`);
    // re-verify a couple suburbs
    for (const s of ["evanston-il", "floral-park-ny"]) {
      const r = await session.run(`MATCH (st:Store)-[:DELIVERS_TO]->(:Location {slug:$s}) RETURN count(DISTINCT st) AS c`, { s });
      console.log(`  ${s}: now ${num(r.records[0].get("c"))} stores`);
    }
  }
} finally { await session.close(); await driver.close(); }
