#!/usr/bin/env node
// One-off / repeatable: set Store.image for every Quicklly store from the seller logo printed on
// its cached listing cards (data-simg). The daily sync now does this per store
// (QuickllyProvider.merchantStoreImage → neo4j.setStoreImage); this fills the ~160 stores that
// were indexed before that existed (Anshul's QA 2026-09-23: empty store icons in the chat and cart).
//
//   node src/scripts/quicklly-backfill-store-images.mjs            # dry run: prints what would change
//   node src/scripts/quicklly-backfill-store-images.mjs --apply    # writes Store.image
//   QUICKLLY_CACHE_ROOT=…  (default <repo>/.quicklly-cache)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../..");
const CACHE_ROOT = process.env.QUICKLLY_CACHE_ROOT || path.join(REPO, ".quicklly-cache");
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");   // also overwrite stores that already have an image

const env = { ...process.env };
for (const line of (fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  const k = t.slice(0, i).trim();
  if (env[k] === undefined) env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));

// slug → first data-simg found in any cached listing page of that store
function logosFromCache() {
  const dir = path.join(CACHE_ROOT, "api-responses");
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f => /-loc-.*\.html$/.test(f)).sort();
  for (const f of files) {
    const slug = f.replace(/-loc-.*$/, "");
    if (out.has(slug)) continue;
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    // a seller without a logo prints the bare folder ".../store/thumb/" — skip, that is not an image
    const m = html.match(/data-simg="(https?:[^"]+\/[^"\/]+\.(?:png|jpe?g|webp|gif|svg)(?:\?[^"]*)?)"/i);
    if (m) out.set(slug, m[1]);
  }
  return out;
}

const session = driver.session();
try {
  const logos = logosFromCache();
  console.log(`cache: ${logos.size} stores with a seller logo`);
  // undo any bare-folder "logo" a previous run may have written (see logosFromCache)
  const bare = await session.run(`MATCH (s:Store) WHERE s.id STARTS WITH 'quicklly_' AND s.image ENDS WITH '/' ` + (APPLY ? `SET s.image = null ` : ``) + `RETURN count(s) AS n`);
  if (bare.records[0].get("n").toNumber() > 0) console.log(`bare-folder images ${APPLY ? "cleared" : "to clear"}: ${bare.records[0].get("n")}`);
  const res = await session.run(`MATCH (s:Store) WHERE s.id STARTS WITH 'quicklly_' RETURN s.id AS id, s.image AS image, s.retiredAt AS retiredAt`);
  const rows = res.records.map(r => r.toObject());
  const plan = [];
  let missingCache = 0;
  for (const r of rows) {
    const slug = r.id.replace(/^quicklly_/, "");
    const url = logos.get(slug);
    if (!url) { if (!r.image && !r.retiredAt) missingCache++; continue; }
    if (r.image && !FORCE) continue;
    plan.push({ id: r.id, url });
  }
  console.log(`graph: ${rows.length} stores, ${rows.filter(r => !r.image).length} without image; ${plan.length} to set; ${missingCache} live stores without image and without a cached listing`);
  for (const p of plan.slice(0, 8)) console.log(`  ${p.id} -> ${p.url}`);
  if (plan.length > 8) console.log(`  … +${plan.length - 8}`);
  if (APPLY && plan.length) {
    const w = await session.run(`UNWIND $plan AS e MATCH (s:Store {id: e.id}) SET s.image = e.url RETURN count(s) AS n`, { plan });
    console.log(`applied: ${w.records[0].get("n")} stores updated`);
  } else if (!APPLY) console.log("dry run (add --apply)");
} finally {
  await session.close(); await driver.close();
}
