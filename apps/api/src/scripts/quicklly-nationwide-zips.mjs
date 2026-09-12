#!/usr/bin/env node
/**
 * Quicklly nationwide store (id 345) — its delivery ZIPs across the WHOLE US, from Quicklly's own
 * availability API (check-store-avaibility, the call their checkout makes), one call per ZIP.
 *
 * Why: the directory's per-ZIP footprint covers only the 3,131 ZIPs of the 813 cities Quicklly has
 * near-me pages for. The nationwide store ships to many ZIPs outside those cities (QA, 2026-09-12: a
 * shopper on such a ZIP saw "Grocery isn't available in this area" while quicklly.com offered the
 * nationwide store). Local stores are shown only in their page cities, so this matters for 345 only.
 *
 * Output: <cacheRoot>/nationwide-zips.json { checkedAt, total, accepted, zips: [...] } (resumable).
 * --apply writes the list to the graph: (:Store {id:'quicklly_quicklly-indian-grocery-nationwide'}).zips
 * The chat reads it as: a ZIP in that list gets the nationwide store even when no :Location holds it.
 *
 *   node quicklly-nationwide-zips.mjs            # probe all US ZIPs (≈42.5k calls, ~40 min at 8-way)
 *   node quicklly-nationwide-zips.mjs --apply    # probe (resuming) and write to the graph
 *   node quicklly-nationwide-zips.mjs --apply --no-probe   # just write the cached list
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
const CACHE_ROOT = process.env.QUICKLLY_CACHE_ROOT || path.resolve(process.cwd(), ".quicklly-cache");
const OUT = path.join(CACHE_ROOT, "nationwide-zips.json");
const NATIONWIDE_ID = "345";
const STORE_NODE = "quicklly_quicklly-indian-grocery-nationwide";
const API = "https://ormwebapi.quicklly.com/user/check-store-avaibility";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CONCURRENCY = parseInt(process.env.QUICKLLY_AVAIL_CONCURRENCY || "8", 10);
const args = process.argv.slice(2);
const APPLY = args.includes("--apply"), NO_PROBE = args.includes("--no-probe");

const env = { ...process.env };
for (const line of (fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "").split("\n")) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("="); const k = line.slice(0, i).trim();
  if (env[k] === undefined) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

async function token() {
  for (const url of ["https://www.quicklly.com/indian-grocery-delivery/near-me-in-chicago-il", "https://www.quicklly.com/"]) {
    const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
    const t = (html.match(/"token":\s*"(eyJ[^"]+)"/) || [])[1];
    if (t) return t;
  }
  throw new Error("no API token on the page");
}

async function probe() {
  const all = Object.keys(zipcodes.codes).filter((k) => /^\d{5}$/.test(k) && (zipcodes.codes[k].country === "US" || !zipcodes.codes[k].country)).sort();
  let state = { checkedAt: null, total: all.length, done: {}, };
  try { const prev = JSON.parse(fs.readFileSync(OUT, "utf8")); if (prev.done) state.done = prev.done; } catch {}
  const todo = all.filter((z) => state.done[z] === undefined);
  console.log(`  [nationwide-zips] ${all.length} US ZIPs, ${Object.keys(state.done).length} already probed, ${todo.length} to go, ${CONCURRENCY}-way`);
  const tok = await token();
  let k = 0, calls = 0, errors = 0; const t0 = Date.now();
  const save = () => { const zips = Object.keys(state.done).filter((z) => state.done[z] === 1).sort(); fs.mkdirSync(CACHE_ROOT, { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), total: all.length, probed: Object.keys(state.done).length, accepted: zips.length, zips, done: state.done })); };
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (k < todo.length) {
      const zip = todo[k++];
      let verdict = null;
      for (let a = 0; a < 3 && verdict === null; a++) {
        try {
          const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ zipcode: zip, storeids: NATIONWIDE_ID, token: tok }) });
          const j = r.ok ? await r.json() : null;
          if (j && j.success === true && Array.isArray(j.lstStores)) verdict = j.lstStores.some((s) => String(s.storeid) === NATIONWIDE_ID) ? 1 : 0;
        } catch {}
        if (verdict === null) await new Promise((res) => setTimeout(res, 800 * (a + 1)));
      }
      calls++;
      if (verdict === null) { errors++; continue; }
      state.done[zip] = verdict;
      if (calls % 500 === 0) { save(); console.log(`  [nationwide-zips]   …${calls}/${todo.length} (${errors} errors, ${Object.values(state.done).filter((v) => v === 1).length} accepted so far, ${Math.round((Date.now() - t0) / 1000)}s)`); }
    }
  }));
  save();
  const accepted = Object.values(state.done).filter((v) => v === 1).length;
  console.log(`  [nationwide-zips] done: ${Object.keys(state.done).length}/${all.length} probed, ${errors} errors, ${accepted} ZIPs accept the nationwide store (${Math.round((Date.now() - t0) / 1000)}s)`);
}

async function apply() {
  const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
  if (!data.zips || data.probed < data.total * 0.95) { console.log(`  [nationwide-zips] NOT applied: only ${data.probed}/${data.total} ZIPs probed`); return; }
  const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
  const s = driver.session();
  try {
    const r = await s.run(`MATCH (st:Store {id: $id}) SET st.zips = $zips, st.zipsCheckedAt = $at RETURN size(st.zips) AS n`, { id: STORE_NODE, zips: data.zips, at: data.checkedAt });
    console.log(`  [nationwide-zips] applied: ${r.records[0]?.get("n")} ZIPs on ${STORE_NODE}`);
  } finally { await s.close(); await driver.close(); }
}

if (!NO_PROBE) await probe();
if (APPLY) await apply();
