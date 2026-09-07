#!/usr/bin/env node
/**
 * Quicklly store directory — the store list their sitemap does not give us.
 * ─────────────────────────────────────────────────────────────────────────────
 * Their sitemap lists ~72 merchants; what shoppers actually see is the near-me page for
 * their city, and those pages disagree with the sitemap in both directions. Measured Sep
 * 2026 from all 813 cities we hold (629 resolve to a real near-me page):
 *   • 74 stores live for shoppers, 9 of them absent from the sitemap (Kalustyans, Fine Fare,
 *     Swagat, the three Metro Markets, …) — never indexed, several in Chicago and NYC;
 *   • 8 stores IN the sitemap that no near-me page lists any more — dead merchants whose
 *     37k products we were still offering to shoppers.
 * A near-me page is authoritative: it is literally the store list a shopper is shown.
 *
 * Output: <cacheRoot>/directory.json
 *   { builtAt, stores: { <slug>: { storeId, name, cities: [...] } } }
 * storeId is the numeric id Quicklly's listing endpoint filters on (`filterstore`) and the
 * cart writes with (`data-sid`). Resolved from the store's own page and cached across runs.
 *
 * Usage:
 *   node quicklly-store-directory.mjs              # (re)build the directory
 *   node quicklly-store-directory.mjs --slugs      # live store slugs, one per line (shell loops)
 *   node quicklly-store-directory.mjs --retire-dead # flag products of indexed stores that no
 *                                                   #   near-me page lists (inStock=false, reversible)
 */
import neo4j from "neo4j-driver";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const CACHE_ROOT = process.env.QUICKLLY_CACHE_ROOT || path.resolve(process.cwd(), ".quicklly-cache");
const OUT = path.join(CACHE_ROOT, "directory.json");
const ORIGIN = "https://www.quicklly.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const NATIONWIDE_SLUG = "quicklly-indian-grocery-nationwide";
const NATIONWIDE_ID = "345";

const args = process.argv.slice(2);
const SLUGS_ONLY = args.includes("--slugs");
const RETIRE_DEAD = args.includes("--retire-dead");
const say = (...a) => { if (!SLUGS_ONLY) console.log(...a); };

// ── env ──────────────────────────────────────────────────────────────────────
const env = { ...process.env };
for (const line of (fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "").split("\n")) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("=");
  const k = line.slice(0, i).trim();
  if (env[k] === undefined) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const num = (v) => (v && typeof v.toNumber === "function" ? v.toNumber() : Number(v || 0));

async function get(url, cookie) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) }, redirect: "follow" });
      if (r.ok) return await r.text();
    } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
  }
  return "";
}

// A near-me page that RESOLVED names the city back in its <title>; an unknown or unserved city
// falls to a generic "Indian Grocery Delivery Online USA" page with no stores. That is the
// signal that separates "no coverage here" from "we built the wrong slug".
const resolved = (html) => /<title>\s*Indian Grocery Delivery in /i.test(html);

async function build() {
  const session = driver.session();
  let cities, zipOf;
  try {
    const r = await session.run(`MATCH (l:Location) RETURN l.slug AS slug, l.zips[0] AS zip`);
    cities = r.records.map((x) => x.get("slug")).filter(Boolean);
    zipOf = new Map(r.records.map((x) => [x.get("slug"), x.get("zip")]));
  } finally { await session.close(); }

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")).stores || {}; } catch {}

  say(`  [directory] reading ${cities.length} near-me pages…`);
  const storeCities = new Map();
  let k = 0, ok = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (k < cities.length) {
      const c = cities[k++];
      const html = await get(`${ORIGIN}/indian-grocery-delivery/near-me-in-${c}`);
      if (!resolved(html)) continue;
      ok++;
      for (const m of html.matchAll(/indian-grocery-store\/[a-z0-9-]+\/([a-z0-9-]+)"/g)) {
        if (!storeCities.has(m[1])) storeCities.set(m[1], new Set());
        storeCities.get(m[1]).add(c);
      }
    }
  }));
  say(`  [directory] ${ok}/${cities.length} cities resolved → ${storeCities.size} live stores`);

  // Numeric store id: the store's own page embeds it (storeid: 'NNN'). Needs a zip session from a
  // city it serves. Cached from the previous directory; only unresolved ones are fetched.
  const stores = {};
  const slugs = [...storeCities.keys()].sort();
  k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < slugs.length) {
      const slug = slugs[k++];
      const cityList = [...storeCities.get(slug)].sort();
      let storeId = prev[slug]?.storeId || null, name = prev[slug]?.name || null;
      if (!storeId) {
        for (const city of cityList.slice(0, 3)) {
          const zip = zipOf.get(city);
          if (!zip) continue;
          const html = await get(`${ORIGIN}/indian-grocery-store/${city}/${slug}`, `pincode=${zip}; postalcode=${zip}; country=us`);
          storeId = (html.match(/storeid:\s*'(\d+)'/) || html.match(/id="astoreid"[^>]*value="(\d+)"/) || [])[1] || null;
          name = ((html.match(/<title>([^<|]{0,80})/) || [])[1] || "").replace(/\s*-\s*Indian Grocery.*$/, "").trim() || null;
          if (storeId) break;
        }
      }
      stores[slug] = { storeId, name, cities: cityList };
    }
  }));
  // Quicklly's own nationwide catalogue is not a near-me store, but it ships everywhere.
  stores[NATIONWIDE_SLUG] = { storeId: NATIONWIDE_ID, name: "Quicklly Indian Grocery Nationwide", cities: [], nationwide: true };

  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), stores }, null, 1));
  const unresolved = slugs.filter((s) => !stores[s].storeId);
  say(`  [directory] wrote ${OUT}: ${slugs.length} live stores + nationwide; ${unresolved.length} without a store id${unresolved.length ? ` (${unresolved.join(", ")})` : ""}`);
  return stores;
}

async function retireDead(stores) {
  const live = new Set(Object.keys(stores).map((s) => `quicklly_${s}`));
  const session = driver.session();
  try {
    const r = await session.run(`MATCH (st:Store) WHERE st.id STARTS WITH 'quicklly_' RETURN st.id AS id`);
    const dead = r.records.map((x) => x.get("id")).filter((id) => !live.has(id));
    if (!dead.length) { say("  [directory] no dead stores"); return; }
    const res = await session.run(
      `UNWIND $dead AS id
       MATCH (st:Store {id: id})-[:HAS_PRODUCT]->(p:Product)
       WHERE coalesce(p.inStock, true) = true
       SET p.inStock = false, p.retiredAt = $now
       RETURN id, count(p) AS n`,
      { dead, now: new Date().toISOString() }
    );
    for (const x of res.records) say(`  [directory] retired ${num(x.get("n"))} products of dead store ${x.get("id")}`);
    say(`  [directory] ${dead.length} store(s) not on any near-me page → their products are no longer offered (reversible: a future directory that lists them flips inStock back on the next sync)`);
  } finally { await session.close(); }
}

try {
  let stores;
  if (SLUGS_ONLY && fs.existsSync(OUT) && (Date.now() - Date.parse(JSON.parse(fs.readFileSync(OUT, "utf8")).builtAt)) < 20 * 3600 * 1000) {
    stores = JSON.parse(fs.readFileSync(OUT, "utf8")).stores;   // fresh enough — don't re-crawl 813 pages twice a day
  } else {
    stores = await build();
  }
  if (RETIRE_DEAD) await retireDead(stores);
  if (SLUGS_ONLY) {
    for (const [slug, s] of Object.entries(stores)) if (s.storeId) console.log(slug);
  }
} finally {
  await driver.close();
}
