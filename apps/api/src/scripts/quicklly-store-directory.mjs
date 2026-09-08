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

  // ── Second source: stores that sell into a city without being on its near-me page ──────────
  // Quicklly runs VIRTUAL first-party stores (e.g. store 113399 "Festive Specials", the seasonal
  // collection) whose products reach shoppers through the location listings but which no
  // near-me page ever lists. The all-stores location listing (no filterstore) for a city returns
  // a data-sid on every card, so asking it for every subcategory in a few hub cities surfaces
  // any such store. Virtual stores sell everywhere, so the first hub already catches them; the
  // extra hubs also add delivery cities the near-me pages under-report.
  await sweepHiddenStores(stores, zipOf);

  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), stores }, null, 1));
  const unresolved = slugs.filter((s) => !stores[s].storeId);
  say(`  [directory] wrote ${OUT}: ${slugs.length} live stores + nationwide; ${unresolved.length} without a store id${unresolved.length ? ` (${unresolved.join(", ")})` : ""}`);
  return stores;
}

const HUBS = ["chicago-il", "manhattan-ny", "edison-nj", "san-jose-ca", "houston-tx", "atlanta-ga", "dallas-tx", "seattle-wa", "boston-ma", "philadelphia-pa"];
const SUBCAT_MENU_DEPTS_PAGE = `${ORIGIN}/indian-grocery/chicago-il/order-groceries`;

async function sweepHiddenStores(stores, zipOf) {
  // one session is enough — the ZIP only scopes the all-stores listing, and we set it per hub
  const idToSlug = new Map(Object.entries(stores).filter(([, s]) => s.storeId).map(([slug, s]) => [String(s.storeId), slug]));
  // global subcategory ids from the location department menus
  let jar = `pincode=60610; postalcode=60610; city=Chicago; state=Illinois; country=us`;
  const seed = await fetch(SUBCAT_MENU_DEPTS_PAGE, { headers: { "User-Agent": UA, Cookie: jar }, redirect: "follow" });
  for (const c of seed.headers.getSetCookie?.() || []) jar += "; " + String(c).split(";")[0];
  const seedHtml = await seed.text();
  const csrf = (seedHtml.match(/name="csrf-token"\s+content="([^"]+)"/i) || [])[1];
  const depts = ((seedHtml.match(/id="subcatsort"[^>]*value="([^"]+)"/) || [])[1] || "").split(",").filter(Boolean);
  const hdr = (referer, cookie) => ({ "User-Agent": UA, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": csrf, Referer: referer, Cookie: cookie });
  const subcats = new Set();
  for (const catid of depts) {
    const t = await (await fetch(`${ORIGIN}/ajax-listnewsubcatmenu.php`, { method: "POST", headers: hdr(SUBCAT_MENU_DEPTS_PAGE, jar), body: JSON.stringify({ catid, catname: "x" }) })).text();
    for (const m of t.matchAll(/getProductsBySubcat\(\s*\d+\s*,\s*(\d+)\s*,/g)) subcats.add(m[1]);
  }
  if (!subcats.size) { say("  [directory] hidden-store sweep skipped: no subcategory ids"); return; }

  const seen = new Map();   // storeId → { name, cities:Set }
  for (const hub of HUBS) {
    const zip = zipOf.get(hub);
    if (!zip) continue;
    const cookie = `pincode=${zip}; postalcode=${zip}; country=us` + jar.slice(jar.indexOf("; PHPSESSID") >= 0 ? jar.indexOf("; PHPSESSID") : jar.length);
    const referer = `${ORIGIN}/local-grocery-store/${hub}/indian-spices`;
    let k = 0; const list = [...subcats];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (k < list.length) {
        const sc = list[k++];
        try {
          const t = await (await fetch(`${ORIGIN}/ajax-subcat-all-products-listing.php`, { method: "POST", headers: hdr(referer, cookie),
            body: JSON.stringify({ subcat_id: sc, limit: 500, start: 0, filterstore: "", filterbrand: "", filterdiscount: "", filtersortby: "", filteraction: "" }) })).text();
          for (const m of t.matchAll(/data-sid="(\d+)"(?:[^>]{0,160}data-sname="([^"]{0,60})")?/g)) {
            if (!seen.has(m[1])) seen.set(m[1], { name: m[2] || null, cities: new Set() });
            else if (m[2] && !seen.get(m[1]).name) seen.get(m[1]).name = m[2];
            seen.get(m[1]).cities.add(hub);
          }
        } catch {}
      }
    }));
  }
  let added = 0, citiesAdded = 0;
  for (const [id, info] of seen) {
    const slug = idToSlug.get(id);
    if (slug) {
      // known store: the sweep can only ADD delivery cities the near-me pages missed
      const before = stores[slug].cities.length;
      stores[slug].cities = [...new Set([...stores[slug].cities, ...info.cities])].sort();
      citiesAdded += stores[slug].cities.length - before;
      continue;
    }
    // unknown store id: resolve its slug/name from one of its product pages
    let name = info.name, storeSlug = null;
    try {
      const t = await (await fetch(`${ORIGIN}/ajax-subcat-all-products-listing.php`, { method: "POST", headers: hdr(`${ORIGIN}/local-grocery-store/chicago-il/indian-spices`, jar),
        body: JSON.stringify({ subcat_id: [...subcats][0], limit: 500, start: 0, filterstore: id, filterbrand: "", filterdiscount: "", filtersortby: "", filteraction: "" }) })).text();
      const pid = (t.match(/data-pid="(\d+)"/) || [])[1];
      if (pid) {
        const pd = await get(`${ORIGIN}/grocery-store/x/${pid}`, jar);
        storeSlug = (pd.match(/indian-grocery-store\/([a-z0-9-]+)\/[a-z0-9-]+"/) || [])[1] || null;
        name = name || (pd.match(new RegExp(`data-sname="([^"]{0,60})"[^>]{0,400}data-pid="${pid}"`)) || [])[1] || null;
      }
    } catch {}
    if (!storeSlug && name) storeSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!storeSlug || stores[storeSlug]) continue;
    stores[storeSlug] = { storeId: id, name: name || storeSlug, cities: [...info.cities].sort(), virtual: true };
    added++;
    say(`  [directory] hidden store found: ${storeSlug} (store_id ${id}, "${name}") — sells into ${info.cities.size} hub cities, on no near-me page`);
  }
  say(`  [directory] hidden-store sweep: ${HUBS.length} hubs × ${subcats.size} subcats → ${seen.size} store ids seen, ${added} added, ${citiesAdded} delivery cities added`);
}

async function retireDead(stores) {
  const live = new Set(Object.keys(stores).map((s) => `quicklly_${s}`));
  const session = driver.session();
  try {
    const r = await session.run(`MATCH (st:Store) WHERE st.id STARTS WITH 'quicklly_' RETURN st.id AS id`);
    const dead = r.records.map((x) => x.get("id")).filter((id) => !live.has(id));
    if (!dead.length) { say("  [directory] no dead stores"); return; }
    const now = new Date().toISOString();
    const res = await session.run(
      `UNWIND $dead AS id
       MATCH (st:Store {id: id})
       SET st.retiredAt = coalesce(st.retiredAt, $now)
       WITH st, id
       OPTIONAL MATCH (st)-[r:DELIVERS_TO]->(:Location)
       DELETE r
       WITH st, id
       OPTIONAL MATCH (st)-[:HAS_PRODUCT]->(p:Product) WHERE coalesce(p.inStock, true) = true
       SET p.inStock = false, p.retiredAt = $now
       RETURN id, count(p) AS n`,
      { dead, now }
    );
    // The store node keeps a `retiredAt` stamp (the health check skips retired stores; a store
    // that syncs again clears it) and loses its DELIVERS_TO edges — a dead store must never
    // count as "local" for any city again.
    for (const x of res.records) say(`  [directory] retired dead store ${x.get("id")} (${num(x.get("n"))} products flagged, delivery edges removed)`);
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
