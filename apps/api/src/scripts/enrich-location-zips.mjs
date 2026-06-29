#!/usr/bin/env node
/**
 * Enrich :Location nodes with their US zip codes.
 * ─────────────────────────────────────────────────────────────────────────────
 * Our Location nodes are keyed by CITY slug ({slug, city, state}); the chat's users
 * enter a ZIP. This bridges the gap: for each Location it looks up all zips for that
 * (city, state) and stores them as `l.zips` — so the runtime resolves a user's zip with
 * one exact lookup:
 *     MATCH (l:Location) WHERE $zip IN l.zips
 *     MATCH (st:Store)-[:DELIVERS_TO]->(l) ...
 *
 * Re-runnable (idempotent). Run after a sync that adds new Locations (e.g. monthly).
 *
 * Usage: node apps/api/src/scripts/enrich-location-zips.mjs [--dry-run]
 */
import neo4j from "neo4j-driver";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zipcodes from "zipcodes";

const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");

const DRY = process.argv.includes("--dry-run");

// Manual overrides for Location slugs the zip dataset can't resolve by city name.
// Manhattan zips are labeled "New York" (not "Manhattan") in the dataset — including
// single-building zips like 10118 (Empire State Bldg) — so we take the FULL "New York, NY"
// set. Queens zips are labeled by neighborhood (Long Island City, Astoria, …) with no
// shared "Queens" label, so it gets an explicit list. Brooklyn / Bronx / Staten Island
// resolve via the normal path (their slug city == the dataset's city label).
const MANHATTAN_ZIPS = zipcodes.lookupByName("New York", "NY").map(r => String(r.zip));
const OVERRIDES = {
  "manhattan-ny": MANHATTAN_ZIPS,
  "upper-manhattan-ny": MANHATTAN_ZIPS,
  "queens-ny": ["11004","11005","11101","11102","11103","11104","11105","11106","11354","11355","11356","11357","11358","11360","11361","11362","11363","11364","11365","11366","11367","11368","11369","11370","11372","11373","11374","11375","11377","11378","11379","11385","11411","11412","11413","11414","11415","11416","11417","11418","11419","11420","11421","11422","11423","11426","11427","11428","11429","11432","11433","11434","11435","11436","11691","11692","11693","11694","11697"],
};
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, "utf8").split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const session = driver.session();
const num = v => v?.toNumber?.() ?? v;

try {
  const res = await session.run(`MATCH (l:Location) RETURN l.slug AS slug, l.city AS city, l.state AS state`);
  const locations = res.records.map(r => ({ slug: r.get("slug"), city: r.get("city"), state: r.get("state") }));
  console.log(`Locations: ${locations.length}`);

  const updates = [];
  const noZip = [];
  for (const loc of locations) {
    let zips;
    if (OVERRIDES[loc.slug]) {
      zips = OVERRIDES[loc.slug];
    } else {
      if (!loc.city || !loc.state) { noZip.push(loc.slug); continue; }
      // zipcodes.lookupByName(city, stateAbbr) → array of records with .zip
      let recs = [];
      try { recs = zipcodes.lookupByName(loc.city, loc.state) || []; } catch { recs = []; }
      zips = [...new Set(recs.map(r => String(r.zip)).filter(Boolean))];
    }
    if (zips.length === 0) { noZip.push(loc.slug); continue; }
    updates.push({ slug: loc.slug, zips });
  }

  const totalZips = updates.reduce((s, u) => s + u.zips.length, 0);
  console.log(`Matched zips for ${updates.length}/${locations.length} locations (${totalZips} zip mappings, avg ${(totalZips / (updates.length || 1)).toFixed(1)}/loc)`);
  console.log(`No-match (city not in zip dataset): ${noZip.length}${noZip.length ? " — e.g. " + noZip.slice(0, 12).join(", ") : ""}`);

  if (DRY) { console.log("\n[dry-run] not writing. Sample:"); updates.slice(0, 5).forEach(u => console.log(`  ${u.slug}: [${u.zips.slice(0, 6).join(", ")}${u.zips.length > 6 ? ", …" : ""}]`)); }
  else {
    // Batch-write in chunks
    const CHUNK = 200;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const batch = updates.slice(i, i + CHUNK);
      await session.run(
        `UNWIND $batch AS u MATCH (l:Location {slug: u.slug}) SET l.zips = u.zips`,
        { batch }
      );
    }
    console.log(`\n✓ Wrote l.zips on ${updates.length} Location nodes.`);
    // verify a known one
    const v = await session.run(`MATCH (l:Location {slug:'los-altos-ca'}) RETURN l.zips AS zips`);
    if (v.records.length) console.log(`  verify los-altos-ca.zips = [${(v.records[0].get("zips") || []).slice(0, 8).join(", ")} …]`);
  }
} finally {
  await session.close();
  await driver.close();
}
