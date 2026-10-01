#!/usr/bin/env node
/**
 * Quicklly's own per-ZIP store list, for every US ZIP → (:QuickllyZip {zip}).stores in the graph.
 *
 * quicklly.com renders "Grocery stores near you" from
 *   POST https://ormwebapi.quicklly.com/grocery/view-all-grocery-stores
 *        {zipcode, uid:0, callForm:'WEBSITE', search:'', page:0, token}   → lstGroceryNearYou[{sid, slug, …}]
 * It answers for ANY ZIP with the complete list on page 0 (page 1 repeats it), and agrees with their
 * checkout availability API. Our own footprint (near-me pages ∩ availability, 3,131 ZIPs of 770
 * cities) misses what lies outside those city lists — measured 2026-10-01 on 750 ZIPs:
 *   • stores that ship far beyond their city (Patel Brothers, D Mart, Apna Bazar Cash and Carry
 *     nationwide; Fresh Farms across the Midwest) were missing from the chat almost everywhere;
 *   • suburbs outside the lists (Jersey City 07306, Austin 78757, Aurora 60504 …) got "Grocery
 *     isn't available" although their site lists local stores.
 * Prices are NOT an obstacle: wherever this API lists a store for a ZIP, the store's own page sells
 * the same products at the same prices as in its home zone (665/665 Patel Brothers New Orleans vs
 * Queens, 592/592 Fresh Farms Indiana vs Chicago, perishables included) — only the delivery fee and
 * minimum order differ. The 10-25% lower "base price" appears only where a store is NOT listed.
 *
 * The chat (LOCATION_STORES_CYPHER) unions this list with the existing rule, so nothing QA accepted
 * disappears; a ZIP whose node exists no longer falls back to an unverified city slug.
 *
 *   node quicklly-zip-stores.mjs                      # probe every US ZIP (≈42.5k calls, resumable)
 *   node quicklly-zip-stores.mjs --apply              # probe (resuming) and write to the graph
 *   node quicklly-zip-stores.mjs --apply --no-probe   # re-apply the cache (new stores get mapped)
 *   node quicklly-zip-stores.mjs --apply --fresh      # ignore the cache, probe everything again
 *   node quicklly-zip-stores.mjs --apply --zips 07306,60504   # just these (testing)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import neo4j from "neo4j-driver";
const require = createRequire(import.meta.url);
const zipcodes = require("zipcodes");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const CACHE_ROOT = process.env.QUICKLLY_CACHE_ROOT || path.join(REPO, ".quicklly-cache");
const OUT = path.join(CACHE_ROOT, "zip-stores.json");
const API = "https://ormwebapi.quicklly.com/grocery/view-all-grocery-stores";
const ORIGIN = "https://www.quicklly.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CONCURRENCY = parseInt(process.env.QUICKLLY_ZIP_STORES_CONCURRENCY || "8", 10);
const args = process.argv.slice(2);
const APPLY = args.includes("--apply"), NO_PROBE = args.includes("--no-probe"), FRESH = args.includes("--fresh");
const ONLY = (() => { const i = args.indexOf("--zips"); return i >= 0 && args[i + 1] ? args[i + 1].split(",").map(s => s.trim()).filter(Boolean) : null; })();
const say = (...a) => console.log("  [zip-stores]", ...a);

const env = { ...process.env };
for (const line of (fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "").split("\n")) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("="); const k = line.slice(0, i).trim();
  if (env[k] === undefined) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

// The page embeds a 24h service token for ormwebapi (the same one their own JS posts).
async function token() {
  for (const url of [`${ORIGIN}/indian-grocery-delivery/near-me-in-chicago`, `${ORIGIN}/`]) {
    try {
      const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
      const t = (html.match(/"token":\s*"(eyJ[^"]+)"/) || html.match(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/) || [])[1];
      if (t) return t;
    } catch { /* next page */ }
  }
  throw new Error("no API token on the page");
}

// → [{sid, slug}] for the ZIP, or null when the call failed (so the ZIP is retried, not recorded empty).
async function storesFor(zip, tok) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA, Origin: ORIGIN },
        body: JSON.stringify({ zipcode: zip, uid: 0, callForm: "WEBSITE", search: "", page: 0, token: tok }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j || j.success === false || !Array.isArray(j.lstGroceryNearYou)) throw new Error("unexpected body");
      return j.lstGroceryNearYou.filter(s => s && s.sid != null).map(s => ({ sid: String(s.sid), slug: s.slug || "" }));
    } catch { await new Promise(res => setTimeout(res, 400 * (attempt + 1))); }
  }
  return null;
}

// A --fresh run works in its own file and only replaces the cache once it has answered for most of
// the country, so a run that dies half-way never leaves the directory builder and the daily
// re-apply with half a picture. (It resumes its own file if that is less than 12 h old.)
const WORK = FRESH ? OUT + ".fresh" : OUT;
function loadState() {
  try {
    const p = JSON.parse(fs.readFileSync(WORK, "utf8"));
    if (FRESH && Date.now() - Date.parse(p.checkedAt || 0) > 12 * 3600 * 1000) return { done: {}, slugs: {} };
    return { done: p.done || {}, slugs: p.slugs || {} };
  } catch { return { done: {}, slugs: {} }; }
}
function saveState(state) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  fs.writeFileSync(WORK + ".tmp", JSON.stringify({ checkedAt: new Date().toISOString(), done: state.done, slugs: state.slugs }));
  fs.renameSync(WORK + ".tmp", WORK);
}

async function probe(state) {
  const all = ONLY || Object.keys(zipcodes.codes).filter(k => /^\d{5}$/.test(k) && (zipcodes.codes[k].country === "US" || !zipcodes.codes[k].country)).sort();
  const todo = ONLY ? all : all.filter(z => state.done[z] === undefined);
  say(`${all.length} ZIPs, ${all.length - todo.length} already probed, ${todo.length} to go, ${CONCURRENCY}-way`);
  if (!todo.length) return all;
  let tok = await token(), i = 0, ok = 0, failed = 0, failStreak = 0, lastSave = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const zip = todo[i++];
      let list = await storesFor(zip, tok);
      if (list === null) {
        failed++; failStreak++;
        // a run of failures usually means the token expired mid-run — mint a new one once
        if (failStreak === 25) { try { tok = await token(); say("token refreshed"); } catch { /* keep going */ } }
        continue;
      }
      failStreak = 0; ok++;
      state.done[zip] = list.map(s => s.sid);
      for (const s of list) if (s.slug) state.slugs[s.sid] = s.slug;
      if ((ok + failed) % 2000 === 0) say(`${ok + failed}/${todo.length} (${failed} failed)`);
      if (Date.now() - lastSave > 60000) { lastSave = Date.now(); saveState(state); }
    }
  }));
  saveState(state);
  say(`probed ${ok} ZIPs this run, ${failed} failed (they stay unprobed and are retried next run)`);
  if (FRESH && !ONLY) {
    const answered = all.filter(z => Array.isArray(state.done[z])).length;
    if (answered >= all.length * 0.9) { fs.renameSync(WORK, OUT); say("fresh probe complete — cache replaced"); }
    else say(`fresh probe answered only ${answered}/${all.length} ZIPs — keeping the previous cache`);
  }
  return all;
}

async function apply(state, all) {
  const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const res = await session.run(`MATCH (s:Store) WHERE s.id STARTS WITH 'quicklly_' AND s.retiredAt IS NULL AND s.store_id IS NOT NULL
                                   RETURN s.id AS id, toString(s.store_id) AS sid, coalesce(s.virtual, false) AS virtual`);
    const idBySid = new Map(), virtual = new Set();
    for (const r of res.records) { idBySid.set(r.get("sid"), r.get("id")); if (r.get("virtual") === true) virtual.add(r.get("sid")); }
    const zips = (ONLY || all).filter(z => Array.isArray(state.done[z]));
    const rows = zips.map(z => ({ zip: z, sids: state.done[z], stores: state.done[z].filter(sid => idBySid.has(sid) && !virtual.has(sid)).map(sid => idBySid.get(sid)) }));
    const withStores = rows.filter(r => r.sids.length).length;
    const unknown = new Map();
    for (const r of rows) for (const sid of r.sids) if (!idBySid.has(sid)) unknown.set(sid, (unknown.get(sid) || 0) + 1);
    say(`${rows.length} ZIPs answered; ${withStores} have at least one store; ${idBySid.size} live stores in the graph`);
    if (unknown.size) say(`stores their API lists that we have not indexed: ${[...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([sid, n]) => `${state.slugs[sid] || "?"}(${sid}) ×${n}`).join(", ")}${unknown.size > 12 ? ` …+${unknown.size - 12}` : ""}`);
    // Refuse to publish a half-finished picture of the country (a ZIP we could not probe keeps its previous node).
    if (!ONLY && rows.length < all.length * 0.9) { say(`only ${rows.length}/${all.length} ZIPs answered — not applying`); process.exitCode = 3; return; }
    if (!APPLY) { say("dry run (add --apply)"); return; }
    await session.run(`CREATE INDEX quicklly_zip_idx IF NOT EXISTS FOR (z:QuickllyZip) ON (z.zip)`);
    const now = new Date().toISOString();
    let n = 0;
    for (let i = 0; i < rows.length; i += 2000) {
      const w = await session.run(`UNWIND $rows AS r MERGE (z:QuickllyZip {zip: r.zip}) SET z.stores = r.stores, z.sids = r.sids, z.checkedAt = $now RETURN count(z) AS n`, { rows: rows.slice(i, i + 2000), now });
      n += w.records[0].get("n").toNumber();
    }
    // the sid → slug names, so the directory can rebuild this index from the graph if the cache file is gone
    await session.run(`MERGE (m:QuickllyZipMeta {id: 'slugs'}) SET m.json = $json, m.updatedAt = $now`, { json: JSON.stringify(state.slugs || {}), now });
    say(`applied: ${n} ZIP nodes written`);
  } finally { await session.close(); await driver.close(); }
}

const state = loadState();
const all = NO_PROBE ? Object.keys(state.done).sort() : await probe(state);
await apply(state, NO_PROBE && !ONLY ? Object.keys(zipcodes.codes).filter(k => /^\d{5}$/.test(k) && (zipcodes.codes[k].country === "US" || !zipcodes.codes[k].country)).sort() : all);
