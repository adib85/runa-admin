#!/usr/bin/env node
// Store-level "⚡ Delivery in 3 hours or less" flag, from Quicklly's own store-list API.
//
// quicklly.com renders its "Grocery stores near you" cards from
//   POST https://ormwebapi.quicklly.com/grocery/view-all-grocery-stores {zipcode, uid:0, callForm:'WEBSITE', search:'', page, token}
// and each store row carries `instantDelivery` (bool) + `deliveryRange` (the text next to the bolt).
// That flag is what their marketing asked the chat to surface (Anshul, 2026-09-30). It is a STORE
// property: probing 30 ZIPs / 80 stores on 2026-10-01 it never differed by ZIP. It is NOT the same
// as the per-product cart flag (data-fastdelivery → Product.fast_delivery): the two disagreed for
// 12 of 70 stores, so the nudge reads this one and the cart keeps the other.
//
// One call per store is enough: we ask for one ZIP the store delivers to and record every store
// that comes back, so ~230 stores need far fewer calls. Stores the API never returns keep their
// previous value (null = unknown = no bolt).
//
//   node src/scripts/quicklly-instant-delivery.mjs            # dry run
//   node src/scripts/quicklly-instant-delivery.mjs --apply    # writes Store.instantDelivery
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../..");
const APPLY = process.argv.includes("--apply");
const API = "https://ormwebapi.quicklly.com/grocery/view-all-grocery-stores";
const ORIGIN = "https://www.quicklly.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_PAGES = 6;
const CONCURRENCY = 4;

const env = { ...process.env };
for (const line of (fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  const k = t.slice(0, i).trim();
  if (env[k] === undefined) env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const say = (...a) => console.log(...a);

// The page embeds a 24h service token for ormwebapi (the same one their own JS posts).
async function apiToken() {
  for (const url of [`${ORIGIN}/indian-grocery-delivery/near-me-in-chicago`, `${ORIGIN}/`]) {
    try {
      const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
      const t = (html.match(/"token":\s*"(eyJ[^"]+)"/) || html.match(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/) || [])[1];
      if (t) return t;
    } catch (_) { /* try the next page */ }
  }
  return null;
}

async function storesForZip(zip, token) {
  const out = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    let list = [];
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA, Origin: ORIGIN },
        body: JSON.stringify({ zipcode: zip, uid: 0, callForm: "WEBSITE", search: "", page, token }) });
      list = ((await r.json()) || {}).lstGroceryNearYou || [];
    } catch (_) { list = []; }
    const fresh = list.filter(s => s && s.sid != null && !out.has(String(s.sid)));
    if (!fresh.length) break;
    for (const s of fresh) out.set(String(s.sid), { sid: String(s.sid), slug: s.slug || "", instant: s.instantDelivery === true, range: s.deliveryRange || "" });
  }
  return out;
}

const session = driver.session();
try {
  const token = await apiToken();
  if (!token) { say("instant-delivery: no API token on the page — nothing changed"); process.exit(2); }
  const res = await session.run(
    `MATCH (s:Store) WHERE s.id STARTS WITH 'quicklly_' AND s.retiredAt IS NULL AND s.store_id IS NOT NULL AND coalesce(s.virtual, false) = false
     OPTIONAL MATCH (s)-[r:DELIVERS_TO]->(l:Location)
     WITH s, collect(coalesce(r.zips, l.zips)) AS zl
     RETURN s.id AS id, toString(s.store_id) AS sid, s.instantDelivery AS prev,
            reduce(acc = [], z IN zl | acc + coalesce(z, []))[0..4] AS zips`);
  const stores = res.records.map(r => ({ id: r.get("id"), sid: r.get("sid"), prev: r.get("prev"), zips: (r.get("zips") || []).map(String) }));
  say(`instant-delivery: ${stores.length} live stores to check`);

  const seen = new Map();          // sid -> { instant, range, slug }
  const asked = new Set();
  let calls = 0;
  // Greedy: a ZIP's answer covers every store listed for it, so most stores are already known by
  // the time their turn comes. Up to 4 ZIPs per store before giving up on it.
  for (let round = 0; round < 4; round++) {
    const todo = [...new Set(stores.filter(s => !seen.has(s.sid) && s.zips[round]).map(s => s.zips[round]))].filter(z => !asked.has(z));
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const batch = todo.slice(i, i + CONCURRENCY).filter(z => {
        // skip a ZIP whose stores were all answered by an earlier call in this round
        return stores.some(s => !seen.has(s.sid) && s.zips[round] === z);
      });
      const results = await Promise.all(batch.map(z => { asked.add(z); calls++; return storesForZip(z, token); }));
      for (const m of results) for (const [sid, v] of m) if (!seen.has(sid)) seen.set(sid, v);
    }
  }

  const rows = stores.filter(s => seen.has(s.sid)).map(s => ({ id: s.id, instant: seen.get(s.sid).instant }));
  const unknown = stores.filter(s => !seen.has(s.sid));
  const changed = stores.filter(s => seen.has(s.sid) && s.prev !== seen.get(s.sid).instant);
  say(`instant-delivery: ${calls} API calls; ${rows.length} stores answered (${rows.filter(r => r.instant).length} instant, ${rows.filter(r => !r.instant).length} not); ${unknown.length} not returned by the API; ${changed.length} changed`);
  if (unknown.length) say(`  not returned: ${unknown.slice(0, 12).map(s => s.id.replace("quicklly_", "")).join(", ")}${unknown.length > 12 ? ` …+${unknown.length - 12}` : ""}`);
  const ranges = {}; for (const v of seen.values()) if (v.instant) ranges[v.range] = (ranges[v.range] || 0) + 1;
  say(`  their label right now: ${Object.entries(ranges).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `"${k}" ×${n}`).join(", ")}`);

  // Refuse a write that would wipe the flag on a bad day (API down / token rejected).
  if (rows.length < Math.max(20, stores.length * 0.5)) { say("instant-delivery: too few stores answered — keeping the previous values"); process.exit(3); }
  if (APPLY) {
    const w = await session.run(`UNWIND $rows AS r MATCH (s:Store {id: r.id}) SET s.instantDelivery = r.instant, s.instantCheckedAt = $now RETURN count(s) AS n`, { rows, now: new Date().toISOString() });
    say(`instant-delivery: applied to ${w.records[0].get("n")} stores`);
  } else say("dry run (add --apply)");
} finally { await session.close(); await driver.close(); }
