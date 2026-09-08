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
 * storeId is the numeric id Quicklly's listing endpoint filters on (`filterstore`) and the
 * cart writes with (`data-sid`). Resolved from the store's own page and cached across runs.
 *
 * WHERE a store delivers is decided per ZIP by Quicklly's own availability API
 * (check-store-avaibility — the call their checkout makes before accepting a cart). Measured
 * Sep 2026: the same city answers differently per ZIP (Dallas 75201 → D-Mart/Apna/Patel/
 * nationwide; Plano 75024 → Desi Brothers only), the nationwide store (345) is available in a
 * specific set of ZIPs (Belle Mead 08502, Dallas 75201… but NOT Chicago, Queens, SF, Anchorage)
 * and the near-me page of a city where it applies is literally the nationwide store's page.
 * So every store — nationwide included — gets `zipsByCity`: the ZIPs of each city where the
 * API says it delivers. A city the near-me page lists but the API rejects for every ZIP keeps
 * an empty list (browsable by city, refused by ZIP — exactly what their site does).
 *
 * Output: <cacheRoot>/directory.json
 *   { builtAt, availability:{checkedAt,zips,calls,errors}, stores: { <slug>: { storeId, name, pageCities, cities, zipsByCity } } }
 *   pageCities = where a near-me page (or a hub listing) shows the store; cities = where it is
 *   offered (pageCities for local stores, the API footprint for the nationwide store).
 *
 * Usage:
 *   node quicklly-store-directory.mjs              # (re)build the directory + apply it to the graph
 *   node quicklly-store-directory.mjs --slugs      # live store slugs, one per line (shell loops)
 *   node quicklly-store-directory.mjs --apply      # (re)write DELIVERS_TO edges + flags from the cached directory
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
const APPLY_ONLY = args.includes("--apply");
const AVAIL_API = "https://ormwebapi.quicklly.com/user/check-store-avaibility";
const AVAIL_CONCURRENCY = parseInt(process.env.QUICKLLY_AVAIL_CONCURRENCY || "8", 10);
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
  // Quicklly's own nationwide catalogue is on no near-me page as a store card — where it applies,
  // the city's near-me page IS its store page. Its cities come from the availability pass below.
  stores[NATIONWIDE_SLUG] = { storeId: NATIONWIDE_ID, name: "Quicklly Indian Grocery Nationwide", cities: [], nationwide: true };

  // ── Second source: stores that sell into a city without being on its near-me page ──────────
  // Quicklly runs VIRTUAL first-party stores (e.g. store 113399 "Festive Specials", the seasonal
  // collection) whose products reach shoppers through the location listings but which no
  // near-me page ever lists. The all-stores location listing (no filterstore) for a city returns
  // a data-sid on every card, so asking it for every subcategory in a few hub cities surfaces
  // any such store. Virtual stores sell everywhere, so the first hub already catches them; the
  // extra hubs also add delivery cities the near-me pages under-report.
  await sweepHiddenStores(stores, zipOf);

  // ── Third source, the decisive one: WHERE each store delivers, per ZIP, from their API ──
  const availability = await availabilityPass(stores);
  if (availability) mergeFootprint(stores, availability.footprint);
  else for (const [slug, st] of Object.entries(prev)) if (stores[slug] && st.zipsByCity) { stores[slug].pageCities = stores[slug].cities.slice().sort(); stores[slug].zipsByCity = st.zipsByCity; stores[slug].cities = Object.keys(st.zipsByCity).sort(); }

  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const meta = availability ? { checkedAt: new Date().toISOString(), zips: availability.zips, calls: availability.calls, errors: availability.errors }
    : (JSON.parse(fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "{}").availability || null);
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), availability: meta, stores }, null, 1));
  const unresolved = slugs.filter((s) => !stores[s].storeId);
  say(`  [directory] wrote ${OUT}: ${slugs.length} live stores + nationwide; ${unresolved.length} without a store id${unresolved.length ? ` (${unresolved.join(", ")})` : ""}`);
  return stores;
}

// The page embeds a 24h service token for ormwebapi (the same one their checkout JS uses).
async function availabilityToken() {
  for (const url of [`${ORIGIN}/indian-grocery-delivery/near-me-in-chicago-il`, `${ORIGIN}/indian-grocery-delivery`, `${ORIGIN}/`]) {
    const html = await get(url);
    const t = (html.match(/"token":\s*"(eyJ[^"]+)"/) || [])[1];
    if (t) return t;
  }
  return null;
}

// One call per ZIP with EVERY store id → the exact store set their checkout accepts for that ZIP.
// ~0.4 s per call; all the ZIPs of all our cities take a few minutes at AVAIL_CONCURRENCY.
async function availabilityPass(stores) {
  const session = driver.session();
  let locs;
  try {
    const r = await session.run(`MATCH (l:Location) WHERE l.zips IS NOT NULL RETURN l.slug AS slug, l.zips AS zips`);
    locs = r.records.map((x) => ({ slug: x.get("slug"), zips: x.get("zips") || [] }));
  } finally { await session.close(); }
  const zipCities = new Map();   // a ZIP can sit in two city slugs (10001: manhattan-ny + upper-manhattan-ny)
  for (const l of locs) for (const z of l.zips) { if (!zipCities.has(z)) zipCities.set(z, []); zipCities.get(z).push(l.slug); }
  const token = await availabilityToken();
  if (!token) { say("  [directory] availability pass SKIPPED: no API token on the page — keeping the previous footprint"); return null; }
  const idToSlug = new Map(Object.entries(stores).filter(([, s]) => s.storeId).map(([slug, s]) => [String(s.storeId), slug]));
  const ids = [...idToSlug.keys()].join(",");
  const zips = [...zipCities.keys()];
  say(`  [directory] availability pass: ${zips.length} ZIPs × ${idToSlug.size} store ids…`);
  const footprint = {};   // slug → city → Set(zip)
  let k = 0, calls = 0, errors = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: AVAIL_CONCURRENCY }, async () => {
    while (k < zips.length) {
      const zip = zips[k++];
      let list = null;
      for (let a = 0; a < 3 && !list; a++) {
        try {
          const r = await fetch(AVAIL_API, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ zipcode: zip, storeids: ids, token }) });
          const j = r.ok ? await r.json() : null;
          if (j && j.success === true && Array.isArray(j.lstStores)) list = j.lstStores;
        } catch {}
        if (!list) await new Promise((res) => setTimeout(res, 1000 * (a + 1)));
      }
      calls++;
      if (!list) { errors++; continue; }
      for (const st of list) {
        const slug = idToSlug.get(String(st.storeid));
        if (!slug) continue;
        for (const city of zipCities.get(zip)) ((footprint[slug] ??= {})[city] ??= new Set()).add(zip);
      }
      if (calls % 500 === 0) say(`  [directory]   …${calls}/${zips.length} ZIPs (${errors} errors, ${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }));
  if (errors > zips.length * 0.05) { say(`  [directory] availability pass ABORTED: ${errors}/${zips.length} ZIPs failed — keeping the previous footprint`); return null; }
  const covered = Object.keys(footprint).length;
  say(`  [directory] availability pass: ${zips.length} ZIPs in ${Math.round((Date.now() - t0) / 1000)}s, ${errors} errors → ${covered} stores have a footprint`);
  return { footprint, zips: zips.length, calls, errors };
}

// What a shopper is SHOWN for a ZIP (their location listing for that ZIP session) is narrower than
// what checkout ACCEPTS (the availability API): a few stores ship far beyond their delivery zone —
// D-Mart, Apna Bazar and Patel Brothers (NJ/NY) pass the API for Dallas 75201, yet the Dallas 75201
// listing shows only the nationwide store. Measured Sep 2026 over 60610, 94022, 08502, 08873, 75201,
// 75024, 75038, 78701, 94305, 11419, 94105, the listing equals:
//   • a local store: accepted by the API for the ZIP AND listed for that city by a near-me page (or
//     seen selling into a hub listing) — pageCities;
//   • the nationwide store: wherever the API accepts it (its cities are exactly its API footprint);
//   • never a virtual store (the chat excludes them in location mode anyway).
// So zipsByCity keeps a local store's API ZIPs only for its page cities. A page city the API rejects
// for every ZIP keeps an empty list (browsable by city, refused by ZIP — as on quicklly.com).
function mergeFootprint(stores, footprint) {
  for (const [slug, st] of Object.entries(stores)) {
    if (!st.storeId) continue;
    const pageCities = (st.pageCities || st.cities || []).slice().sort();
    const zipsByCity = {};
    if (st.nationwide) {
      for (const [city, set] of Object.entries(footprint[slug] || {})) zipsByCity[city] = [...set].sort();
    } else {
      for (const city of pageCities) zipsByCity[city] = [...(footprint[slug]?.[city] || [])].sort();
    }
    st.pageCities = pageCities;
    st.zipsByCity = zipsByCity;
    st.cities = Object.keys(zipsByCity).sort();
  }
}

// Write the directory's footprint to the graph for every store it holds: DELIVERS_TO edges
// (with r.zips) to exactly its cities, plus the store flags the chat reads. Runs after each
// build so coverage is right before the product sync starts, and standalone via --apply.
async function applyFootprint(stores) {
  const rows = Object.entries(stores).filter(([, s]) => s.storeId).map(([slug, s]) => ({
    id: `quicklly_${slug}`, storeId: String(s.storeId), nationwide: !!s.nationwide, virtual: !!s.virtual,
    entries: Object.entries(s.zipsByCity || Object.fromEntries((s.cities || []).map((c) => [c, null]))).map(([city, zips]) => ({ slug: city, zips })),
  }));
  const now = new Date().toISOString();
  const session = driver.session();
  try {
    const res = await session.run(
      `UNWIND $rows AS row
       MATCH (s:Store {id: row.id})
       SET s.store_id = coalesce(s.store_id, row.storeId), s.nationwide = row.nationwide, s.virtual = row.virtual
       WITH s, row
       OPTIONAL MATCH (s)-[old:DELIVERS_TO]->(ol:Location) WHERE NOT ol.slug IN [e IN row.entries | e.slug]
       DELETE old
       WITH DISTINCT s, row
       UNWIND (CASE WHEN size(row.entries) = 0 THEN [null] ELSE row.entries END) AS e
       OPTIONAL MATCH (l:Location {slug: e.slug})
       FOREACH (_ IN CASE WHEN l IS NULL THEN [] ELSE [1] END |
         MERGE (s)-[r:DELIVERS_TO]->(l) SET r.lastSeenAt = $now, r.zips = e.zips, r.source = 'availability-api')
       RETURN row.id AS id, count(l) AS n, size(row.entries) AS want`,
      { rows, now }
    );
    let stores_ = 0, edges = 0;
    for (const x of res.records) { stores_++; edges += num(x.get("n")); }
    say(`  [directory] applied footprint: ${stores_}/${rows.length} stores in the graph, ${edges} delivery edges`);
    for (const x of res.records) if (num(x.get("n")) === 0 && num(x.get("want")) > 0) say(`  [directory]   ${x.get("id")}: none of its ${num(x.get("want"))} cities exist as :Location yet (created on its next sync)`);
  } finally { await session.close(); }
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
  const cached = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  const fresh = cached && (Date.now() - Date.parse(cached.builtAt)) < 20 * 3600 * 1000;
  if ((SLUGS_ONLY && fresh) || (APPLY_ONLY && cached) || (RETIRE_DEAD && !SLUGS_ONLY && !APPLY_ONLY && fresh)) {
    stores = cached.stores;   // fresh enough — don't re-crawl 813 pages twice a day
  } else {
    stores = await build();
    await applyFootprint(stores);
  }
  if (APPLY_ONLY) await applyFootprint(stores);
  if (RETIRE_DEAD) await retireDead(stores);
  if (SLUGS_ONLY) {
    for (const [slug, s] of Object.entries(stores)) if (s.storeId) console.log(slug);
  }
} finally {
  await driver.close();
}
