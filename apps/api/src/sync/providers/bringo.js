/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BRINGO PROVIDER — Product Sync Implementation (SCRAPER)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Bringo (https://www.bringo.ro) is a Romanian grocery-delivery marketplace. It has
 * NO public product API, so this provider is a SCRAPER:
 *   1. Read the public sitemaps to enumerate product page URLs.
 *   2. Keep only URLs for a single store (default: carrefour_hipermarket).
 *   3. Fetch each product's HTML and parse JSON-LD + the add-to-cart form for fields.
 *
 * It plugs into the same SyncOrchestrator/BaseProvider pipeline as Shopify/VTEX, so
 * AI enrichment, embeddings, and the Neo4j write all happen in BaseProvider unchanged.
 * Modeled on VtexProvider (cursor pagination, custom transform, RON, RO descriptions).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * USAGE (from apps/api):
 *   node src/scripts/sync-modular.js bringo carrefour_hipermarket --max 20 --dry-run
 *   node src/scripts/sync-modular.js bringo carrefour_hipermarket            # food-first
 *   node src/scripts/sync-modular.js bringo carrefour_hipermarket --all-categories
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * DATA EXTRACTED PER PRODUCT PAGE
 *   - JSON-LD Product:  name, image, brand.name, description (rich HTML: ingredients,
 *                       allergens, nutrition, origin, manufacturer)
 *   - JSON-LD BreadcrumbList: category path (position 3 = leaf category display name)
 *   - add-to-cart form `data-afanalytics`: price (IN-STOCK ONLY; out-of-stock pages
 *                       carry no price), plus the internal cart id
 *   - "Numar produs": supplier SKU (EAN-like, shared across stores)
 *   - related-carousel ecommerce items: ids + names + prices (kept as a metafield)
 *
 * Product node key = the trailing integer of the URL (globally unique across Bringo).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { BaseProvider } from "./base.js";
import { delay, mapWithConcurrency, storePrefixedId } from "../utils/index.js";

const BRINGO_ORIGIN = "https://www.bringo.ro";
const SITEMAP_INDEX = `${BRINGO_ORIGIN}/sitemaps/sitemap-generic-index.xml`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// All 26 top-level groups carrefour_hipermarket exposes (from the store menu), with display
// names. Roots of the --all-categories crawl. The slug set also stops the category crawl from
// following the global nav menu links as if they were children.
const TOP_GROUPS = [
  { slug: "legume-si-fructe-31", name: "Legume si fructe" },
  { slug: "lactate-branzeturi-oua-3", name: "Lactate, branzeturi, oua" },
  { slug: "brutarie-patiserie-si-cofetarie-3", name: "Brutarie, patiserie si cofetarie" },
  { slug: "macelarie-si-peste-41", name: "Macelarie si peste" },
  { slug: "mezeluri-110", name: "Mezeluri" },
  { slug: "produse-congelate-82", name: "Produse congelate" },
  { slug: "bacanie-169", name: "Bacanie" },
  { slug: "dulciuri-si-snacks-49", name: "Dulciuri si snacks" },
  { slug: "bauturi-si-tutun-10", name: "Bauturi si tutun" },
  { slug: "mancare-gatita-21", name: "Mancare gatita" },
  { slug: "bio-vegetale-si-dietetice-4", name: "Bio, vegetale si dietetice" },
  { slug: "inghetata-150", name: "Inghetata" },
  { slug: "petshop-62", name: "Petshop" },
  { slug: "curatenie-si-intretinere-41", name: "Curatenie si intretinere" },
  { slug: "cosmetice-52", name: "Cosmetice" },
  { slug: "univers-bebe-38", name: "Univers bebe" },
  { slug: "articole-pentru-bucatarie-42", name: "Articole pentru bucatarie" },
  { slug: "jucarii-sport-si-papetarie-4", name: "Jucarii, sport si papetarie" },
  { slug: "textile-20", name: "Textile" },
  { slug: "casa-auto-si-gradina-14", name: "Casa, auto si gradina" },
  { slug: "marca-proprie-carrefour-18", name: "Marca proprie Carrefour" },
  { slug: "reduceri-de-gama-3", name: "Reduceri de gama" },
  { slug: "nou-la-carrefour-4", name: "Nou la Carrefour" },
  { slug: "act-for-good-5", name: "Act for Good" },
  { slug: "aniversar-2", name: "Aniversar" },
  { slug: "lego-fun-packs-2", name: "LEGO Fun Packs" },
];
const TOP_GROUP_SLUGS = TOP_GROUPS.map(g => g.slug);

// Food / grocery top groups — the food-first pilot scope.
const FOOD_GROUPS = [
  { slug: "legume-si-fructe-31", name: "Legume si fructe" },
  { slug: "lactate-branzeturi-oua-3", name: "Lactate, branzeturi, oua" },
  { slug: "brutarie-patiserie-si-cofetarie-3", name: "Brutarie, patiserie si cofetarie" },
  { slug: "macelarie-si-peste-41", name: "Macelarie si peste" },
  { slug: "mezeluri-110", name: "Mezeluri" },
  { slug: "produse-congelate-82", name: "Produse congelate" },
  { slug: "bacanie-169", name: "Bacanie" },
  { slug: "dulciuri-si-snacks-49", name: "Dulciuri si snacks" },
  { slug: "bauturi-si-tutun-10", name: "Bauturi si tutun" },
  { slug: "mancare-gatita-21", name: "Mancare gatita" },
  { slug: "bio-vegetale-si-dietetice-4", name: "Bio, vegetale si dietetice" },
  { slug: "inghetata-150", name: "Inghetata" },
];

export class BringoProvider extends BaseProvider {
  constructor(config) {
    super(config);

    // Which Bringo store to index (the URL slug). shopName doubles as the Neo4j store id.
    this.storeSlug = config.storeSlug || config.shopName || "carrefour_hipermarket";

    // Food-only by default (crawl the food category tree, keep only products whose leaf
    // category falls under a food group, and attach each product's FULL category chain).
    // --all-categories indexes every product (leaf category only, no tree needed).
    this.foodFirst = config.foodFirst !== false;

    // Scraping etiquette. Polite defaults to avoid tripping Cloudflare rate-limits on a
    // ~10k-request run from one IP (robots Allow: / permits the paths, but volume can throttle).
    // ~3 concurrent + ~400ms jittered delay ≈ 2 req/s. Tune via env for faster/slower runs.
    this.scrapeConcurrency = config.scrapeConcurrency || (parseInt(process.env.BRINGO_SCRAPE_CONCURRENCY, 10) || 3);
    this.scrapeDelayMs = config.scrapeDelayMs ?? (parseInt(process.env.BRINGO_SCRAPE_DELAY_MS, 10) || 400);

    // Category crawl bounds. The crawl is "until-dry" (stops when a level yields no new
    // categories); categoryDepth is just a safety cap. Env overrides help a fast smoke
    // test (e.g. BRINGO_CATEGORY_DEPTH=2 BRINGO_MAX_CATEGORY_PAGES=120).
    this.categoryDepth = config.categoryDepth ?? (parseInt(process.env.BRINGO_CATEGORY_DEPTH, 10) || 8);
    this.maxCategoryPages = config.maxCategoryPages ?? (parseInt(process.env.BRINGO_MAX_CATEGORY_PAGES, 10) || 3000);

    // Bringo product pages already carry a rich description (JSON-LD), so the base
    // pipeline won't AI-generate one. Skip Google grounding (no need; avoids cost).
    this.descriptionLanguage = "ro";
    this.skipGrounding = true;
    this.skipSeo = true;            // TOFF-branded SEO is irrelevant for groceries (skip 10k Gemini calls)
    this.defaultConcurrency = config.aiConcurrency || 5;

    // Internal state
    this.productUrls = null;          // [{ url, categorySlug, productId }]
    this.cursorIndex = 0;
    this.categoryBySlug = new Map();   // slug -> { slug, name, parentSlug, topGroupSlug }
    this.foodLeafSlugs = new Set();    // every slug discovered under a food group (full slug, w/ number)
    this.foodBaseSlugs = new Set();    // base slugs (number stripped) — the stable join key
    this.baseSlugIndex = new Map();    // baseSlug -> [full slugs]  (for product → tree node resolution)
    this.nameIndex = new Map();        // lowercased name -> [full slugs]  (fallback when the slug doesn't match, e.g. numeric slug "233" vs menu "oua")

    this.stats = { fetched: 0, parsed: 0, parseFailed: 0, inStock: 0, noPrice: 0 };

    this.treeCacheFile = path.resolve(
      process.cwd(),
      `.bringo-category-tree-${this.storeSlug}.json`
    );
  }

  get providerType() {
    return "Bringo";
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HTTP (browser UA + gzip + retry/backoff). node-fetch decompresses gzip itself.
  // ═══════════════════════════════════════════════════════════════════════════════

  async httpGet(url, { retries = 4 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
          },
          redirect: "follow",
        });

        if (res.status === 403 || res.status === 429 || res.status >= 500) {
          if (attempt < retries) {
            const backoff = Math.min(2000 * Math.pow(2, attempt), 30000) + Math.floor(Math.random() * 500);
            console.log(`  [Bringo] HTTP ${res.status} on ${url} — retry ${attempt + 1}/${retries} in ${(backoff / 1000).toFixed(1)}s`);
            await delay(backoff);
            continue;
          }
          throw new Error(`Bringo HTTP ${res.status} for ${url}`);
        }
        if (!res.ok) throw new Error(`Bringo HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        if ((err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || /network|socket/i.test(err.message)) && attempt < retries) {
          const backoff = Math.min(2000 * Math.pow(2, attempt), 20000);
          console.log(`  [Bringo] ${err.code || "network"} on ${url} — retry ${attempt + 1}/${retries} in ${(backoff / 1000).toFixed(1)}s`);
          await delay(backoff);
          continue;
        }
        throw err;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CATEGORY TREE — crawl food groups (or all 26) to map leaf→group for food filtering
  // and to provide the breadcrumb ancestry for HAS_CATEGORY edges.
  // ═══════════════════════════════════════════════════════════════════════════════

  storeUrl(slug) {
    return `${BRINGO_ORIGIN}/ro/stores/${this.storeSlug}/${slug}`;
  }

  // The trailing "-<number>" on a category slug is a volatile per-context counter
  // (e.g. nav menu "apa-plata-45" vs product URL "apa-plata-21"). Strip it to get the
  // STABLE key used to join product category slugs against the crawled category tree.
  baseSlug(slug) {
    return String(slug || "").replace(/-\d+$/, "");
  }

  // Pull child category links from a category page. The global top-group nav uses
  // different markup, so we additionally exclude the 26 known top-group slugs and the
  // page's own slug, plus any ?sorting/?limit pagination variants (collapse at "?").
  extractCategoryLinks(html, selfSlug) {
    const out = new Map();
    const re = new RegExp(
      `href="/ro/stores/${this.storeSlug}/([^"?#/]+)"[^>]*>([\\s\\S]*?)</a>`,
      "g"
    );
    let m;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1];
      if (!slug || slug === selfSlug || slug === this.storeSlug) continue;
      if (TOP_GROUP_SLUGS.includes(slug)) continue;
      const name = m[2].replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
      if (!name) continue;
      if (!out.has(slug)) out.set(slug, name);
    }
    return [...out.entries()].map(([slug, name]) => ({ slug, name }));
  }

  async fetchCategoryTree() {
    // Use cached tree if present (one-time crawl, reused across runs). Keyed on
    // foodFirst + depth so a deeper recrawl doesn't silently reuse a shallow tree.
    if (this.categoryBySlug.size === 0 && fs.existsSync(this.treeCacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.treeCacheFile, "utf-8"));
        if (cached.foodFirst === this.foodFirst && cached.depth === this.categoryDepth
            && Array.isArray(cached.nodes) && cached.nodes.length) {
          for (const n of cached.nodes) {
            this.categoryBySlug.set(n.slug, n);
            const base = this.baseSlug(n.slug);
            this.foodBaseSlugs.add(base);
            if (!this.baseSlugIndex.has(base)) this.baseSlugIndex.set(base, []);
            this.baseSlugIndex.get(base).push(n.slug);
            const nm = (n.name || "").toLowerCase().trim();
            if (nm) { if (!this.nameIndex.has(nm)) this.nameIndex.set(nm, []); this.nameIndex.get(nm).push(n.slug); }
          }
          this.foodLeafSlugs = new Set(cached.foodLeafSlugs || []);
          console.log(`  [Bringo] Loaded category tree from cache (${this.categoryBySlug.size} categories, ${this.foodBaseSlugs.size} base slugs)`);
          return;
        }
      } catch { /* fall through to recrawl */ }
    }

    const roots = this.foodFirst ? FOOD_GROUPS : TOP_GROUPS;

    console.log(`  [Bringo] Crawling category tree (${this.foodFirst ? "food groups" : "all groups"}, max depth ${this.categoryDepth}, concurrency ${this.scrapeConcurrency})...`);

    // Register a category the moment it is DISCOVERED (the page cap then only limits how
    // deep we crawl, never which discovered leaves survive for food filtering).
    const register = (n) => {
      if (this.categoryBySlug.has(n.slug)) return false;
      this.categoryBySlug.set(n.slug, { slug: n.slug, name: n.name, parentSlug: n.parentSlug, topGroupSlug: n.topGroupSlug });
      this.foodLeafSlugs.add(n.slug);
      const base = this.baseSlug(n.slug);
      this.foodBaseSlugs.add(base);
      if (!this.baseSlugIndex.has(base)) this.baseSlugIndex.set(base, []);
      this.baseSlugIndex.get(base).push(n.slug);
      const nm = (n.name || "").toLowerCase().trim();
      if (nm) { if (!this.nameIndex.has(nm)) this.nameIndex.set(nm, []); this.nameIndex.get(nm).push(n.slug); }
      return true;
    };

    let frontier = [];
    for (const r of roots) {
      const root = { slug: r.slug, name: r.name, parentSlug: null, topGroupSlug: r.slug };
      if (register(root)) frontier.push(root);
    }

    // Concurrent level-by-level BFS: fetch a whole level in parallel, register the next.
    let pagesFetched = 0;
    for (let depth = 0; depth < this.categoryDepth && frontier.length; depth++) {
      if (pagesFetched >= this.maxCategoryPages) {
        console.log(`  [Bringo] Category crawl hit page cap (${this.maxCategoryPages}); tree is partial.`);
        break;
      }
      const level = frontier.slice(0, this.maxCategoryPages - pagesFetched);
      const childLists = await mapWithConcurrency(level, this.scrapeConcurrency, async (node) => {
        try {
          const html = await this.httpGet(this.storeUrl(node.slug));
          return this.extractCategoryLinks(html, node.slug);
        } catch (e) {
          console.log(`  [Bringo] category page failed (${node.slug}): ${e.message}`);
          return [];
        }
      });
      pagesFetched += level.length;

      const next = [];
      level.forEach((node, idx) => {
        for (const child of childLists[idx]) {
          const childNode = { slug: child.slug, name: child.name, parentSlug: node.slug, topGroupSlug: node.topGroupSlug };
          if (register(childNode)) next.push(childNode);
        }
      });
      console.log(`  [Bringo]   depth ${depth + 1}: +${next.length} new categories (${this.categoryBySlug.size} total, ${pagesFetched} pages)`);
      frontier = next;
    }

    console.log(`  [Bringo] Category tree: ${this.categoryBySlug.size} categories (${pagesFetched} pages fetched)`);
    try {
      fs.writeFileSync(this.treeCacheFile, JSON.stringify({
        foodFirst: this.foodFirst,
        depth: this.categoryDepth,
        foodLeafSlugs: [...this.foodLeafSlugs],
        nodes: [...this.categoryBySlug.values()],
      }));
    } catch (e) {
      console.log(`  [Bringo] could not cache category tree: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SITEMAP → product URL list
  // ═══════════════════════════════════════════════════════════════════════════════

  extractLocs(xml) {
    const out = [];
    const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
    return out;
  }

  // Product URL: /ro/stores/<store>/<categorySlug>/products/<nameSlug>/<id>
  parseProductUrl(url) {
    const m = url.match(new RegExp(`/ro/stores/${this.storeSlug}/([^/]+)/products/([^/]+)/(\\d+)`));
    if (!m) return null;
    return { url, categorySlug: m[1], handle: m[2], productId: m[3] };
  }

  async loadProductUrls() {
    console.log("  [Bringo] Reading sitemap index...");
    const indexXml = await this.httpGet(SITEMAP_INDEX);
    const productSitemaps = this.extractLocs(indexXml).filter(u => /sitemap-generic-product-\d+\.xml/.test(u));
    console.log(`  [Bringo] ${productSitemaps.length} product sitemaps`);

    const byId = new Map();
    let totalForStore = 0;
    for (const sm of productSitemaps) {
      const xml = await this.httpGet(sm);
      for (const loc of this.extractLocs(xml)) {
        if (!loc.includes(`/stores/${this.storeSlug}/`)) continue;
        const parsed = this.parseProductUrl(loc);
        if (!parsed) continue;
        totalForStore++;
        // Join on the BASE slug (numbers differ between product URLs and the nav tree).
        if (this.foodFirst && !this.foodBaseSlugs.has(this.baseSlug(parsed.categorySlug))) continue;
        if (!byId.has(parsed.productId)) byId.set(parsed.productId, parsed);
      }
      console.log(`  [Bringo] ${sm.split("/").pop()} → running total: ${byId.size} kept`);
    }

    this.productUrls = [...byId.values()];
    console.log(
      `  [Bringo] ${this.storeSlug}: ${totalForStore} product URLs, ` +
      `${this.productUrls.length} kept${this.foodFirst ? " (food-first)" : ""}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRODUCT PAGE PARSING
  // ═══════════════════════════════════════════════════════════════════════════════

  // ld+json blocks can hold MULTIPLE concatenated JSON objects; scan balanced braces.
  parseJsonLd(html) {
    const objs = [];
    const blockRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let block;
    while ((block = blockRe.exec(html)) !== null) {
      const text = block[1];
      let i = 0;
      while (i < text.length) {
        while (i < text.length && /[\s;,]/.test(text[i])) i++;
        if (i >= text.length || text[i] !== "{") break;
        const slice = this.balancedObject(text, i);
        if (!slice) break;
        try {
          const parsed = JSON.parse(slice.str);
          if (parsed && parsed["@graph"] && Array.isArray(parsed["@graph"])) objs.push(...parsed["@graph"]);
          else objs.push(parsed);
        } catch { /* skip malformed */ }
        i = slice.end;
      }
    }
    return objs;
  }

  // Return the balanced {...} object starting at startIdx (string-aware), and the index after it.
  balancedObject(s, startIdx) {
    let depth = 0, inStr = false, esc = false;
    for (let i = startIdx; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return { str: s.slice(startIdx, i + 1), end: i + 1 };
        }
      }
    }
    return null;
  }

  findType(objs, type) {
    return objs.find(o => o && (o["@type"] === type || (Array.isArray(o["@type"]) && o["@type"].includes(type)))) || null;
  }

  stripHtml(s) {
    if (!s) return "";
    return String(s)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // "8,19" (RON string) → 8.19; a number in bani → /100.
  toRon(v) {
    if (v == null) return null;
    if (typeof v === "number") return Math.round(v) / 100;
    const num = parseFloat(String(v).replace(/\./g, "").replace(",", "."));
    return Number.isFinite(num) ? num : null;
  }

  parseProductPage(html) {
    const objs = this.parseJsonLd(html);
    const product = this.findType(objs, "Product");
    if (!product || !product.name) return null;

    const brand = product.brand && typeof product.brand === "object" ? product.brand.name : product.brand;

    const crumbs = this.findType(objs, "BreadcrumbList");
    let breadcrumb = [];
    if (crumbs && Array.isArray(crumbs.itemListElement)) {
      breadcrumb = crumbs.itemListElement
        .slice()
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .map(e => e.name || (e.item && e.item.name))
        .filter(Boolean);
    }
    // [Home, Carrefour Hipermarket, <leaf category>, <product>] → leaf = position 3
    const leafCategory = breadcrumb.length > 2 ? breadcrumb[breadcrumb.length - 2] : null;

    const inStock = !/Nu este pe stoc/i.test(html) && !/bringo-out-of-stock/i.test(html);

    // Price (in-stock only) — from the add-to-cart form's data-afanalytics, taken from the
    // part of the page BEFORE the related-products carousel (carousel items also carry prices).
    const carouselIdx = html.indexOf("bringo-similar-products-carousel");
    const main = carouselIdx > -1 ? html.slice(0, carouselIdx) : html;
    let price = null, initialPrice = null, discountRate = null;
    const afaIdx = main.indexOf("data-afanalytics='");
    if (afaIdx > -1) {
      const start = main.indexOf("{", afaIdx);
      const obj = start > -1 ? this.balancedObject(main, start) : null;
      if (obj) {
        try {
          const afa = JSON.parse(obj.str);
          price = this.toRon(afa.price);
          initialPrice = this.toRon(afa.initial_price);
          discountRate = afa.discount_rate || null;
        } catch { /* ignore */ }
      }
    }

    const skuMatch = html.match(/Numar produs:<\/strong>\s*([0-9A-Za-z\-]+)/);
    const internalIdMatch = main.match(/\/ajax\/cart\/add-item\/(\d+)/);

    // Related-carousel ecommerce items (kept as a metafield; useful later for pairings).
    const related = [];
    const ecomRe = /\{"product_type"[\s\S]*?"currency":"RON"\}/g;
    let e;
    while ((e = ecomRe.exec(html)) !== null) {
      try {
        const item = JSON.parse(e[0]);
        if (String(item.item_id) !== String(internalIdMatch && internalIdMatch[1])) {
          related.push({ id: item.item_id, name: item.item_name, price: this.toRon(item.price) });
        }
      } catch { /* ignore */ }
    }

    return {
      name: product.name,
      image: product.image || null,
      brand: brand || null,
      descriptionHtml: product.description || "",
      breadcrumb,
      leafCategory,
      inStock,
      price,
      initialPrice,
      discountRate,
      sku: skuMatch ? skuMatch[1] : null,
      internalId: internalIdMatch ? internalIdMatch[1] : null,
      related,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NORMALIZE → the shape BaseProvider.processProducts + neo4j.saveProducts expect
  // ═══════════════════════════════════════════════════════════════════════════════

  // Resolve a product's full category chain [leaf → … → topGroup] from the crawled tree.
  // Products join the tree by BASE slug; when a base maps to several tree nodes we
  // disambiguate by the leaf NAME from the product's own breadcrumb.
  resolveChain(categorySlug, leafName) {
    // The breadcrumb leaf NAME is the authoritative category, so anchor the chain on it
    // FIRST. The URL slug can be a misleading cross-listing (e.g. a "Branzeturi" product
    // crawled under a "cascaval-4" slug, or eggs under the numeric "233"). Fall back to the
    // URL slug only when the breadcrumb name isn't known to the menu tree.
    let candidates = leafName ? (this.nameIndex.get(leafName.toLowerCase().trim()) || []) : [];
    if (!candidates.length) {
      candidates = this.baseSlugIndex.get(this.baseSlug(categorySlug)) || [];
    }
    let node = null;
    if (candidates.length === 1) {
      node = this.categoryBySlug.get(candidates[0]);
    } else if (candidates.length > 1) {
      const named = leafName && leafName.toLowerCase();
      node = candidates.map(s => this.categoryBySlug.get(s))
        .find(n => n && named && n.name && n.name.toLowerCase() === named)
        || this.categoryBySlug.get(candidates[0]);
    }

    const chain = [];
    const guard = new Set();
    let cur = node;
    while (cur && !guard.has(cur.slug)) {
      guard.add(cur.slug);
      chain.push({ title: cur.name, slug: cur.slug });
      cur = cur.parentSlug ? this.categoryBySlug.get(cur.parentSlug) : null;
    }
    return chain; // leaf-first; empty if the leaf slug wasn't found in the tree
  }

  buildCollections(parsed, urlInfo) {
    // Full category chain in natural breadcrumb order: topGroup ▸ … ▸ leaf. Every level
    // becomes a HAS_CATEGORY edge (and a CHILD_OF link in the writer). The provider's
    // determineCategory() override picks the LAST element (leaf) as the primary category.
    const collections = [];
    const seen = new Set();
    const push = (title, handle) => {
      const t = (title || "").trim();
      if (!t || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase());
      collections.push({ id: handle || t, title: t, handle: handle || null });
    };

    const chain = this.resolveChain(urlInfo.categorySlug, parsed.leafCategory); // leaf-first
    if (chain.length) {
      // top→leaf; handle = STABLE base slug (number stripped) so re-crawls don't fork nodes.
      for (const c of chain.slice().reverse()) push(c.title, this.baseSlug(c.slug));
    } else {
      // Not found in the tree — fall back to the breadcrumb leaf alone.
      push(parsed.leafCategory || urlInfo.categorySlug, this.baseSlug(urlInfo.categorySlug));
    }
    return collections;
  }

  // Groceries: the primary category is the most specific LEAF (last element of the
  // top→leaf chain), not the fashion-list fallback the base uses.
  determineCategory(product) {
    if (product.collections && product.collections.length) {
      return product.collections[product.collections.length - 1].title;
    }
    return product.product_type || "";
  }

  normalizeProduct(parsed, urlInfo) {
    const collections = this.buildCollections(parsed, urlInfo); // top→leaf
    const leafName = collections.length ? collections[collections.length - 1].title : (parsed.leafCategory || "");
    const topGroupName = collections.length ? collections[0].title : "";
    const price = parsed.price;

    return {
      // PREFIX the id with the store slug. The Neo4j writer MERGEs products globally by id,
      // so a raw Bringo id (e.g. "359") would overwrite a fashion product with the same id.
      // Namespacing guarantees Bringo products never collide with other stores' nodes.
      id: storePrefixedId(this.storeSlug, urlInfo.productId),
      title: parsed.name,
      body_html: parsed.descriptionHtml || "",
      descriptionHtml: parsed.descriptionHtml || "",
      handle: urlInfo.handle,
      vendor: parsed.brand || "",
      product_type: leafName,
      status: "active",
      tags: "",
      tagsAsCategories: false,
      published_at: null,
      price: price ?? null,
      sku: parsed.sku || null,
      image: parsed.image || null,
      images: parsed.image ? [{ src: parsed.image, alt: parsed.name }] : [],
      variants: [
        {
          id: `${storePrefixedId(this.storeSlug, urlInfo.productId)}-default`,
          title: "Default",
          price: price ?? 0,
          compare_at_price: parsed.initialPrice ?? null,
          sku: parsed.sku || "",
          inventory_quantity: parsed.inStock ? 1 : 0,
        },
      ],
      options: [],
      collections,
      // Tells the Neo4j writer to use the store-namespaced Category + CHILD_OF path
      // (keeps the grocery taxonomy isolated from the shared/global fashion categories).
      categoryHierarchy: true,
      metafields: [
        { key: "bringo_product_id", value: String(urlInfo.productId), namespace: "bringo" },
        { key: "source_url", value: urlInfo.url, namespace: "bringo" },
        { key: "in_stock", value: String(parsed.inStock), namespace: "bringo" },
        { key: "bringo_internal_id", value: parsed.internalId || "", namespace: "bringo" },
        { key: "supplier_sku", value: parsed.sku || "", namespace: "bringo" },
        { key: "category_slug", value: urlInfo.categorySlug, namespace: "bringo" },
        { key: "top_group", value: topGroupName, namespace: "bringo" },
        { key: "discount_rate", value: parsed.discountRate || "", namespace: "bringo" },
        { key: "related_ids", value: parsed.related.map(r => r.id).join(","), namespace: "bringo" },
      ],
      // Groceries have no gender; keep empty so no HAS_DEMOGRAPHIC edge is created.
      detectedDemographics: [],
    };
  }

  async scrapeOne(urlInfo) {
    let html;
    try {
      html = await this.httpGet(urlInfo.url);
      this.stats.fetched++;
    } catch (e) {
      console.log(`  [Bringo] fetch failed ${urlInfo.url}: ${e.message}`);
      return null;
    }
    const parsed = this.parseProductPage(html);
    if (!parsed) {
      this.stats.parseFailed++;
      return null;
    }
    this.stats.parsed++;
    if (parsed.inStock) this.stats.inStock++;
    if (parsed.price == null) this.stats.noPrice++;
    if (this.scrapeDelayMs) await delay(this.scrapeDelayMs + Math.floor(Math.random() * this.scrapeDelayMs));
    return this.normalizeProduct(parsed, urlInfo);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PROVIDER INTERFACE
  // ═══════════════════════════════════════════════════════════════════════════════

  async fetchProducts(options = {}) {
    // Lazy one-time init. Always crawl the category tree: in food mode it also drives the
    // food filter; in all-categories mode it provides the parent chains for HAS_CATEGORY /
    // CHILD_OF (products whose slug doesn't base-match the menu fall back to a flat leaf).
    if (this.productUrls === null) {
      await this.fetchCategoryTree();
      await this.loadProductUrls();
      // Do NOT reset cursorIndex here — on a --force resume, base.restoreCursorState() has
      // already set it to the last checkpoint. The constructor defaults it to 0 for fresh runs.
    }

    const limit = options.limit || 20;
    const batch = this.productUrls.slice(this.cursorIndex, this.cursorIndex + limit);
    if (batch.length === 0) {
      return { products: [], nextCursor: null, hasNextPage: false };
    }

    const total = this.productUrls.length;
    console.log(`  [Bringo] Scraping ${batch.length} products (${this.cursorIndex + 1}-${this.cursorIndex + batch.length} of ${total})`);

    const scraped = await mapWithConcurrency(batch, this.scrapeConcurrency, (item) => this.scrapeOne(item));
    const products = scraped.filter(Boolean);
    this.cursorIndex += batch.length;

    // Circuit breaker: if almost the whole batch failed, we're likely throttled/blocked.
    // Stop gracefully instead of hammering through the rest — cursor state allows resume.
    if (batch.length >= 5 && products.length / batch.length < 0.2) {
      console.warn(`  [Bringo] ⚠ ${batch.length - products.length}/${batch.length} fetches failed this batch — likely rate-limited/blocked. Stopping; resume later from index ${this.cursorIndex}.`);
      return { products, nextCursor: null, hasNextPage: false };
    }

    const hasNextPage = this.cursorIndex < total;
    return {
      products,
      nextCursor: hasNextPage ? String(this.cursorIndex) : null,
      hasNextPage,
    };
  }

  async fetchCollections() {
    // Return [] so the base SKIPS its global flat createOrUpdateCategories. Bringo categories
    // are created per-product through the store-namespaced Category + CHILD_OF path (writer
    // Query 3b), which keeps the grocery taxonomy isolated from the shared fashion categories.
    // (The category tree is crawled lazily in fetchProducts for filtering + chain resolution.)
    return [];
  }

  async getShopData() {
    return { currency: "RON", name: this.storeSlug, domain: "bringo.ro" };
  }

  // Groceries have no garment colour — skip the per-product Gemini VISION call the base
  // pipeline runs by default (would be ~10k pointless vision calls on a full sync).
  async detectColorFromImage() {
    return null;
  }

  // NO LLM. Derive the search attributes from data we already scraped, instead of the
  // fashion-tuned gpt-4o-mini classifier (which forces a woman/man demographic + a fashion
  // category and is wrong for food). product = leaf category; characteristics = brand + leaf.
  // These feed productEmbedding / characteristicsEmbedding; the rich contentEmbedding
  // (title + ingredients/nutrition) carries the main semantic signal. Dietary/cuisine/
  // meal-type tags are added later by a deliberate, food-aware pass (not here).
  async extractProductProperties(content, product) {
    const cols = product.collections || [];
    const leaf = cols.length ? cols[cols.length - 1].title : (product.product_type || product.title || "");
    const brand = product.vendor || "";
    const characteristics = [brand, leaf].filter(Boolean).join(", ");
    return {
      product: leaf || "unknown",
      characteristics: characteristics || "unknown",
      color: "",
      material: "",
      demographic: "",
      category: leaf,
    };
  }

  getCursorState() {
    return { cursorIndex: this.cursorIndex, stats: { ...this.stats } };
  }

  restoreCursorState(state) {
    if (!state) return;
    this.cursorIndex = state.cursorIndex || 0;
    if (state.stats) this.stats = { ...this.stats, ...state.stats };
    console.log(`  [Bringo] Restored cursor: index ${this.cursorIndex}`);
  }

  logFinalStats() {
    console.log("\n  ════════════════════════════════════════════════════════════");
    console.log("  [Bringo] SCRAPE STATS:");
    console.log(`    Pages fetched:        ${this.stats.fetched}`);
    console.log(`    Parsed OK:            ${this.stats.parsed}`);
    console.log(`    Parse failed:         ${this.stats.parseFailed}`);
    console.log(`    In stock:             ${this.stats.inStock}`);
    console.log(`    No price (OOS):       ${this.stats.noPrice}`);
    console.log("  ════════════════════════════════════════════════════════════\n");
  }

  async sync() {
    console.log(`\n=== Starting ${this.providerType} Sync for ${this.shopName} ===`);
    console.log(`  [Bringo] Store: ${this.storeSlug} | mode: ${this.foodFirst ? "FOOD-FIRST" : "ALL CATEGORIES"}\n`);
    await super.sync();
    this.logFinalStats();
  }
}

export default BringoProvider;
