#!/usr/bin/env node
/**
 * Quicklly merchant enumerator
 * ─────────────────────────────────────────────────────────────────────────────
 * Walks Quicklly's public sitemaps and lists every grocery MERCHANT, with the
 * delivery LOCATIONS and SUBCATEGORIES each one exposes. This is the discovery
 * input for the batch runner (sync-quicklly-all.sh) — it answers "which stores
 * exist and how big is each one" before we sync.
 *
 * Sitemaps are fetched live and cached to `.quicklly-cache/sitemaps/` (the SAME
 * dir QuicklyProvider reads), so a subsequent `sync-modular.js quicklly <slug>`
 * reuses them and never re-fetches the sitemap.
 *
 * Usage:
 *   node apps/api/src/scripts/list-quicklly-merchants.mjs            # human-readable table
 *   node apps/api/src/scripts/list-quicklly-merchants.mjs --json     # JSON to stdout
 *   node apps/api/src/scripts/list-quicklly-merchants.mjs --out merchants.json
 *   node apps/api/src/scripts/list-quicklly-merchants.mjs --slugs    # bare slugs, one per line (for shell loops)
 */
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const ORIGIN = "https://www.quicklly.com";
const SITEMAP_INDEX = `${ORIGIN}/sitemap.xml`;
const EXTRA_SITEMAPS = [`${ORIGIN}/sitemap_prod.xml`];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Cache to the same dir QuicklyProvider uses (cwd-relative, matches the provider's
// default cacheRoot = process.cwd()/.quicklly-cache).
const CACHE_ROOT = process.env.QUICKLLY_CACHE_ROOT || path.resolve(process.cwd(), ".quicklly-cache");
const SITEMAP_DIR = path.join(CACHE_ROOT, "sitemaps");

// Nationwide / ships-everywhere merchants: their sitemap location list is NOT their
// true footprint (they ship across the US), so we flag them. Keep in sync with the
// QUICKLLY_NATIONWIDE_MERCHANTS set in providers/quicklly.js.
const NATIONWIDE = new Set([
  "sold-by-quicklly",
  "sold-by-quicklly-edison",
  "quicklly-indian-grocery-nationwide",
]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const asSlugs = args.includes("--slugs");
const outIdx = args.indexOf("--out");
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

function cacheNameForUrl(url) {
  return url.replace(/^https?:\/\//, "").replace(/[\/?&=]/g, "_");
}

async function httpGet(url, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*;q=0.8" },
        redirect: "follow",
      });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const backoff = Math.min(2000 * 2 ** attempt, 30000);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        throw new Error(`HTTP ${res.status} ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt < retries && /network|socket|ECONN|ETIMEDOUT/i.test(err.message)) {
        await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 20000)));
        continue;
      }
      throw err;
    }
  }
}

async function cachedGet(url) {
  const cachePath = path.join(SITEMAP_DIR, cacheNameForUrl(url) + ".xml");
  try {
    return await fs.promises.readFile(cachePath, "utf8");
  } catch {}
  const body = await httpGet(url);
  await fs.promises.mkdir(SITEMAP_DIR, { recursive: true });
  await fs.promises.writeFile(cachePath, body);
  return body;
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

async function loadSitemapLeaves() {
  const seen = new Set();
  const queue = [SITEMAP_INDEX, ...EXTRA_SITEMAPS];
  const leaves = [];
  while (queue.length) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    let xml;
    try { xml = await cachedGet(u); } catch (e) { console.error(`  ! skip ${u}: ${e.message}`); continue; }
    if (/<sitemapindex/i.test(xml)) {
      for (const c of extractLocs(xml)) queue.push(c);
    } else {
      leaves.push(xml);
    }
  }
  return leaves;
}

async function main() {
  if (!asJson && !asSlugs) console.error(`[enum] walking sitemaps (cache: ${SITEMAP_DIR})…`);
  const leaves = await loadSitemapLeaves();

  const merchants = new Map(); // slug -> { locations:Set, subcats:Set }
  const ensure = slug => {
    if (!merchants.has(slug)) merchants.set(slug, { locations: new Set(), subcats: new Set() });
    return merchants.get(slug);
  };

  for (const xml of leaves) {
    for (const url of extractLocs(xml)) {
      let parts;
      try { parts = new URL(url).pathname.replace(/^\/|\/$/g, "").split("/"); } catch { continue; }
      // /indian-grocery/<loc>/<merchant>/<subcat>
      if (parts[0] === "indian-grocery" && parts.length === 4) {
        const m = ensure(parts[2]);
        m.locations.add(parts[1]);
        m.subcats.add(parts[3]);
      }
      // /indian-grocery-store/<loc>/<merchant>  (captures locations even with no subcat URL)
      if (parts[0] === "indian-grocery-store" && parts.length >= 3) {
        ensure(parts[2]).locations.add(parts[1]);
      }
    }
  }

  const list = [...merchants.entries()]
    .map(([slug, v]) => ({
      slug,
      locations: v.locations.size,
      subcats: v.subcats.size,
      nationwide: NATIONWIDE.has(slug),
    }))
    // Skip merchants with no subcats (store-landing-only entries with nothing to index)
    .filter(m => m.subcats > 0)
    .sort((a, b) => b.subcats - a.subcats);

  if (asSlugs) {
    for (const m of list) console.log(m.slug);
    return;
  }
  if (asJson || outFile) {
    const json = JSON.stringify(list, null, 2);
    if (outFile) {
      fs.writeFileSync(outFile, json);
      console.error(`[enum] wrote ${list.length} merchants -> ${outFile}`);
    }
    if (asJson) console.log(json);
    return;
  }

  // Human-readable table
  console.error(`\n[enum] ${list.length} merchants (${leaves.length} sitemap leaves)\n`);
  console.log(`${"MERCHANT".padEnd(48)} SUBCATS  LOCS  SCOPE`);
  console.log("─".repeat(78));
  for (const m of list) {
    console.log(
      `${m.slug.padEnd(48)} ${String(m.subcats).padStart(6)} ${String(m.locations).padStart(5)}  ${m.nationwide ? "NATIONWIDE" : "local"}`
    );
  }
  const totalSubcats = list.reduce((s, m) => s + m.subcats, 0);
  console.log("─".repeat(78));
  console.log(`Total: ${list.length} merchants, ~${totalSubcats} subcat-fetches for full discovery`);
}

main().catch(e => { console.error("enumerator failed:", e); process.exit(1); });
