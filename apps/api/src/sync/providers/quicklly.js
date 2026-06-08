/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * QUICKLLY PROVIDER — Product Sync (SCRAPER, location-first marketplace)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Quicklly (https://www.quicklly.com) is a US-based Indian grocery MARKETPLACE — many
 * merchants, each delivering to a set of cities. There is no public API, so this
 * provider scrapes:
 *   1. The public sitemaps (cached on disk under `data/sitemaps/`) enumerate every
 *      `/indian-grocery/<location>/<merchant>/<subcategory>` URL, which gives us:
 *        - which merchants exist
 *        - which canonical subcategories each merchant exposes
 *        - which locations each merchant delivers to
 *   2. For each merchant, ONE listing page fetch per subcategory reveals the inline
 *      `storeid`, `catid`, `subcaid` values needed to call the products endpoint.
 *   3. `POST https://www.quicklly.com/ajax-subcat-all-products.php` returns HTML
 *      with `data-pid` / `data-name` / `data-price` per product card, paginated
 *      via `start=500, 1000, ...` until exhausted.
 *
 * IMPORTANT — PER-MERCHANT MODEL:
 *   Each Quicklly merchant becomes its OWN runa-admin :Store node:
 *     shopName = storeSlug = `quicklly_<merchant-slug>`   (e.g. `quicklly_taj-mahal-fresh-market`)
 *   Product ids are namespaced as `storePrefixedId(shopName, rawPid)` — guaranteed to
 *   never collide with other stores' nodes (the same merchant carries no duplicate pids;
 *   the same physical product across merchants gets DIFFERENT pids — verified empirically).
 *
 * IMPORTANT — LOCATION:
 *   The chat is location-anchored. Each merchant's delivery footprint is captured at
 *   sync time by passing the locations[] up to a one-shot writer that creates
 *   `:Location` nodes and `(:Store)-[:DELIVERS_TO]->(:Location)` edges. The new writer
 *   methods (`createOrUpdateLocations`, `linkStoreDelivery`) need to be added to
 *   `services/neo4j.js`; until that lands, locations are written as a metafield CSV
 *   on every product as a fallback (set FALLBACK_LOCATION_METAFIELD=true).
 *
 * USAGE (per merchant — same shape as Bringo):
 *   node src/scripts/sync-modular.js quicklly taj-mahal-fresh-market
 *   node src/scripts/sync-modular.js quicklly indian-mega-mart --dry-run --max 5
 *   node src/scripts/sync-modular.js quicklly desi-india-bazaar --force
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WHAT WE EMBED (4 vectors per product, one batched OpenAI call, no Gemini):
 *   - titleEmbedding         : title_normalized
 *   - productEmbedding       : product_type (title minus brand minus pack_size)
 *   - characteristicsEmbedding: `${brand}, ${product_type}, ${pack_size}, ${aliases}`
 *   - contentEmbedding       : `${title} — ${brand} — ${subcategory} — ${aliases}`
 *
 * `aliases` injects Hindi/regional synonyms (haldi→turmeric, jeera→cumin, etc.) so
 * chat queries in either English or Hindi-mixed English hit the same products.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { BaseProvider } from "./base.js";
import { delay, mapWithConcurrency, storePrefixedId } from "../utils/index.js";

const QUICKLLY_ORIGIN = "https://www.quicklly.com";
const SITEMAP_INDEX = `${QUICKLLY_ORIGIN}/sitemap.xml`;
const EXTRA_SITEMAPS = [`${QUICKLLY_ORIGIN}/sitemap_prod.xml`]; // not in the index, referenced separately
const PRODUCTS_API = `${QUICKLLY_ORIGIN}/ajax-subcat-all-products.php`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ─── Known Indian-grocery brands ────────────────────────────────────────────────
// Used to extract `vendor` from a title's leading token(s). Sorted longest-first
// so multi-word brands win (e.g. "MAMA SITAS" beats "MAMA").
const KNOWN_BRANDS = [
  "MAMA SITAS","HALDIRAM","AASHIRVAAD","BRITANNIA","DR.OETKER","DR OETKER",
  "KWIK MEAL","BROOKE BOND","WAGH BAKRI","INDIAN HARVEST","COOL TIME",
  "MOPLLEEZ","KURKURE","SUJATHA","SUJATA","DEEP","LAXMI","SHAN","MTR","GOYA",
  "ANAND","NATIONAL","TAPAL","SURATI","NESTLE","PARLE","DABUR","PRIYA","SWAD",
  "TOOBA","SHUDH","CHINGS","LAZIZA","NANAK","MEZBAN","AMMAS","ADARSH","KCB",
  "MDH","EBM","KTC","ASLI","AHMED","SHER","BONOMI","TYJ","VIGO","ZDAN",
  "PILLSBURY","NIHAR","DURVESH","ZIYAD","NUTRELA","HACIZADE","LIBANIAS",
  "ELMILAGRO","EL MILAGRO","LAYS","LEHAR","QUIKTEA","QUIK TEA","BIOS","OLYBIO",
  "PARACHUTE","CIUTI","SAFFRON","POLISH FOLKLORE","ZAIQA","ROOH AFZA","MANI",
];

// ─── Words that are NEVER brands ────────────────────────────────────────────────
// Generic meat/fish/produce nouns, prep descriptors, sizes, packaging, religious
// sourcing prefixes, color qualifiers — these masquerade as brands when they
// happen to be the first capitalized word of an unbranded title. The fallback in
// extractBrand() rejects any match in this set. Lowercased; matched on the first token.
const NON_BRAND_FIRST_WORDS = new Set([
  // meat / poultry / seafood nouns
  "beef","chicken","lamb","goat","mutton","pork","veal","turkey","duck","quail",
  "fish","shrimp","prawn","prawns","crab","lobster","squid","octopus",
  // Bangladeshi / South-Asian fish species commonly seen as the first word
  "rohu","hilsha","ilish","elish","katla","koi","mola","keski","puti","shoil","shol",
  "baim","bata","baila","chapilla","chapila","chitol","chelapata","gutum","foly","taki",
  "nola","sharputi","telapia","tilapia","poa","chokkah","dhani","rani","lotia","chiring",
  "meni","parshe","lakkah","taposhi","golda","migral","gura","deshi","nona","bagda",
  "rupchanda","pomfret","pabda","tengra","shing","magur","boal",
  // size / prep / packaging descriptors
  "baby","whole","boneless","bone","skinless","fresh","frozen","dry","dried",
  "raw","cooked","ready","cut","clean","minced","ground","sliced","steak","fillet",
  "big","small","medium","large","jumbo","mini","tiny","long","short","extra",
  "tray","pack","bag","box","piece","pieces","lb","kg","oz","gm",
  // religious / sourcing prefixes
  "halal","kosher","organic","wild","farm","farmed","imported","local","native",
  // generic colors / qualifiers
  "silver","golden","red","green","white","black","yellow","mixed","king","queen","star",
]);

// ─── Indian/regional → English alias injection ──────────────────────────────────
// Per-title: when a title contains either side (matched at word boundaries — see
// aliasesFor), both sides are appended to the product's `aliases_text` (which
// feeds characteristicsEmbedding + contentEmbedding). This is the single
// highest-leverage recall improvement we can ship.
const ALIASES = {
  // — Spices —
  haldi: "turmeric", jeera: "cumin", dhania: "coriander", saunf: "fennel",
  elaichi: "cardamom", hing: "asafoetida",
  // — Pulses / lentils —
  chana: "chickpea", rajma: "kidney beans", masoor: "red lentils",
  toor: "pigeon peas", moong: "mung beans", urad: "black gram",
  // — Flours / staples —
  atta: "wheat flour", maida: "all-purpose flour", besan: "chickpea flour",
  sooji: "semolina", rava: "semolina", suji: "semolina",
  poha: "flattened rice",
  // — Dairy / cooking —
  paneer: "indian cheese cottage cheese", ghee: "clarified butter",
  dahi: "yogurt curd",
  // — Basics —
  namak: "salt", chini: "sugar", adrak: "ginger", lehsun: "garlic",
  mirchi: "chili", imli: "tamarind", laung: "clove", dalchini: "cinnamon",
  javitri: "mace", jaiphal: "nutmeg", ajwain: "carom seeds",
  kalonji: "nigella seeds", methi: "fenugreek", tulsi: "holy basil",
  pudina: "mint", kothmir: "coriander leaves",
  // — Produce —
  aam: "mango", nimbu: "lemon", kheera: "cucumber",
  baingan: "eggplant", aloo: "potato", gobi: "cauliflower",
  matar: "peas", bhindi: "okra", palak: "spinach",
  // — Snacks / sweets —
  murmura: "puffed rice", sev: "fried noodles snack", namkeen: "savory snack",
  papad: "lentil cracker", achar: "pickle", chutney: "relish",
  laddu: "sweet ball", barfi: "milk fudge", gulab: "rose",
  kesar: "saffron", supari: "betel nut", masala: "spice mix",
  // — Dishes —
  biryani: "rice dish", pulao: "pilaf rice", roti: "flatbread",
  naan: "leavened flatbread", paratha: "stuffed flatbread",
  chapati: "flatbread", samosa: "savory pastry", pakora: "fritter",
  // — Meat / offal / cuts (halal-catalog vocabulary) —
  // Protein-NEUTRAL to avoid cross-pollinating "Beef Keema" with 'chicken' and vice
  // versa. The species is anchored by the SUBCATEGORY alias fallback (beef-products
  // → "red meat halal"; chicken-products → "poultry meat"; goat-products → "goat
  // meat halal mutton").
  keema: "minced ground meat",
  kheema: "minced ground meat",
  paya: "trotters feet hoof leg",
  boti: "chunks pieces cubed",
  kalija: "liver",
  magaj: "brain",
  gurda: "kidney",
  raan: "leg roast haunch",
  chaap: "chop cutlet",
  seekh: "skewer kebab",
  tikka: "marinated cubes",
  // — Bengali fish → English category (helps English queries reach Bengali names) —
  hilsha: "hilsa ilish shad fish",
  ilish: "hilsa hilsha shad fish",
  elish: "hilsa hilsha shad fish",
  rohu: "rui carp fish",
  katla: "catla carp fish",
  mrigal: "carp fish",
  migral: "mrigal carp fish",
  puti: "barb fish",
  mola: "minnow fish",
  koi: "climbing perch fish",
  shing: "stinging catfish fish",
  magur: "walking catfish fish",
  tengra: "catfish fish",
  pabda: "butter catfish fish",
  boal: "wallago catfish fish",
  chitol: "featherback knife fish",
  foly: "featherback knife fish",
  shoil: "snakehead fish",
  shol: "snakehead fish",
  taki: "snakehead fish",
  baim: "eel fish",
  bata: "mullet fish",
  parshe: "mullet fish",
  lotia: "bombay duck fish",
  rupchanda: "pomfret fish",
  telapia: "tilapia fish",
  tilapia: "tilapia fish",
  chapila: "sardine fish",
  chapilla: "sardine fish",
  keski: "anchovy fish",
  gutum: "loach catfish fish",
  baila: "goby fish",
  meni: "leaf fish",
  poa: "croaker fish",
  // — Crustaceans —
  chingri: "shrimp prawn",
  chiring: "shrimp prawn",
  golda: "freshwater prawn shrimp",
  bagda: "tiger prawn shrimp",
  // — Modifiers —
  deshi: "native local country",
  desi: "native local country",
  nona: "salted brackish",
  // — Misc poultry / game (fills gaps surfaced in v3 audit) —
  quail: "poultry bird game",
};

// Subcategory-driven fallback aliases: when a product has no title-hit alias but
// its subcategory is a strong English anchor, inject the anchor. e.g. any product
// under `sea-food` gets "fish seafood" added even if its title is bare Bengali.
const SUBCATEGORY_ALIASES = {
  "sea-food": "fish seafood",
  "chicken-products": "poultry meat",
  "beef-products": "red meat halal",
  "goat-products": "goat meat halal mutton",
  "lamb-products": "lamb meat halal mutton",
  "veal-products": "veal meat halal",
  "marinated-meat": "marinated meat",
  "frozen-meat": "frozen meat halal",
  "paneer-products": "paneer indian cheese cottage cheese",
  "dal-and-pulses": "dal lentils pulses",
  "atta-wheat-flour": "atta wheat flour",
  "besan-sooji-rava": "besan sooji rava chickpea-flour semolina",
  "indian-spices": "spices masala",
  "oil-ghee": "oil ghee clarified butter",
  "tea-coffee": "tea coffee chai",
  "namkeen-chips-munchies": "snacks namkeen chips",
  "biscuits-cookies-cake": "biscuits cookies cake",
  "indian-desserts": "indian sweets desserts mithai",
  "pickles": "pickle achar",
  "dairy-products": "dairy milk",
  "dairy-milk-products": "dairy milk",
  "salt-sugar-jaggery": "salt sugar jaggery",
  "bread-and-eggs": "bread eggs",
  "fresh-vegetables": "fresh vegetables produce",
  "fresh-fruits": "fresh fruits produce",
  "frozen-vegetables-fruits": "frozen vegetables fruits",
  "poha-rice-products": "rice poha basmati",
  "noodles": "noodles",
  "sauce-ketchup-chutney": "sauce ketchup chutney",
  "ready-to-eat-and-cook": "ready to eat ready to cook",
  "frozen-foods": "frozen food",
  "frozen-pizza": "frozen pizza",
  "breakfast-cereals": "breakfast cereals",
  "ice-creams": "ice cream",
  "cold-drink-juices": "drinks juices beverages",
  "canned-food": "canned food",
  "indian-tofee-and-chocolates": "toffee chocolate candy",
  "jams-spreads": "jam spread",
};

// Precompile word-boundary regex per alias key so short keys (paya, koi, poa)
// don't substring-match unrelated English words.
const ALIAS_KEYS_BY_LENGTH = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const ALIAS_REGEX = new Map();
for (const key of ALIAS_KEYS_BY_LENGTH) {
  ALIAS_REGEX.set(key, new RegExp(`\\b${key}\\b`, "i"));
}

// Compiled once: longest-first list of brands, lowercased — for prefix matching.
const BRAND_TOKENS = KNOWN_BRANDS
  .map((b) => b.toLowerCase())
  .sort((a, b) => b.length - a.length);

// Pack-size regex — captures sizes like "10 lbs", "500 g", "1 kg", "16 fl oz",
// AND ranges "3-4 Lb", "1.5-1.7 KG", "2 to 4 kg", "2 T0 4 KG" (Quicklly typo).
// Groups: (1) low number, (2) optional high number, (3) unit. NB no leading \b
// because Quicklly puts sizes inside parens like "(3-4Lb)" which means the digit
// is preceded by "(".
const PACK_RE =
  /(\d+(?:\.\d+)?)\s*(?:(?:[-–]|\s+(?:to|t0)\s+)\s*(\d+(?:\.\d+)?))?\s*(lbs?|fl\.?\s*oz|oz|kgs?|gms?|g|ml|l|ct|count|pack|each|pcs?|pc)\b/i;

// Normalize captured unit to a canonical short form.
function normalizeUnit(u) {
  const lc = u.toLowerCase().replace(/\s+/g, " ").trim();
  if (lc === "lbs" || lc === "lb")           return "lb";
  if (lc === "kgs" || lc === "kg")           return "kg";
  if (lc === "gms" || lc === "gm" || lc === "g") return "g";
  if (lc === "pcs" || lc === "pc")           return "pc";
  if (lc === "count" || lc === "ct")         return "ct";
  if (/^fl\.?\s*oz$/i.test(lc))              return "fl oz";
  return lc;
}

// Department prefixes Quicklly sprinkles into titles (e.g. "OIL - NIHAR MUSTARD OIL").
// We strip them from `title_normalized` to tighten embeddings — but keep them on the
// original `title` for display.
const DEPT_PREFIX_RE =
  /^(oil|atta|ghee|tea|coffee|urad dal|moong dal|toor dal|chana dal|masoor dal|dal|rice|flour|spices?|masala)\s*-\s*/i;

export class QuicklyProvider extends BaseProvider {
  constructor(config) {
    super(config);

    // The merchant we're syncing. `shopName` doubles as the Neo4j :Store id.
    this.merchantSlug = config.merchantSlug || config.shopName?.replace(/^quicklly_/, "") || "fresh-farms";
    this.shopName = `quicklly_${this.merchantSlug}`;
    this.storeSlug = this.shopName;

    // Scraping politeness (Quicklly is on Cloudflare).
    this.scrapeConcurrency = config.scrapeConcurrency ||
      (parseInt(process.env.QUICKLLY_SCRAPE_CONCURRENCY, 10) || 4);
    this.scrapeDelayMs = config.scrapeDelayMs ??
      (parseInt(process.env.QUICKLLY_SCRAPE_DELAY_MS, 10) || 250);
    this.maxPagesPerSubcat = parseInt(process.env.QUICKLLY_MAX_PAGES_PER_SUBCAT, 10) || 10;

    // BaseProvider knobs — copy Bringo's grocery-tuned defaults.
    this.descriptionLanguage = "en";
    this.skipGrounding = true;     // we never call Gemini description for Quicklly
    this.skipSeo = true;            // TOFF-branded SEO is fashion-only
    this.defaultConcurrency = config.aiConcurrency || 5;
    this.descriptionSkip = config.descriptionSkip !== false; // body_html = title shortcut

    // Cache directories — local to apps/api process cwd.
    this.cacheRoot = config.cacheRoot ||
      process.env.QUICKLLY_CACHE_ROOT ||
      path.resolve(process.cwd(), ".quicklly-cache");
    this.sitemapDir   = path.join(this.cacheRoot, "sitemaps");
    this.pagesDir     = path.join(this.cacheRoot, "category-pages");
    this.apiDir       = path.join(this.cacheRoot, "api-responses");

    // Optional: when neo4j writer hasn't yet been extended for :Location nodes,
    // dump the merchant's delivery footprint as a metafield CSV on each product.
    this.fallbackLocationMetafield =
      config.fallbackLocationMetafield ??
      (process.env.QUICKLLY_FALLBACK_LOCATION_METAFIELD === "true");

    // Internal state — populated lazily on the first fetchProducts call.
    this.merchantContext = null;   // { subcats, locations, firstLoc }
    this.merchantStoreId = null;
    this.subcatCatalog = null;     // [{subcat, subcaid, catid, products: []}]
    this.normalizedProducts = null;
    this.cursorIndex = 0;
    this.stats = { sitemapsRead: 0, pagesFetched: 0, apiCalls: 0, products: 0 };
  }

  get providerType() {
    return "Quicklly";
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HTTP — retry-aware GET / POST. Quicklly sits behind Cloudflare; throttle aggressively.
  // ═══════════════════════════════════════════════════════════════════════════════

  async http(url, init = {}, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          ...init,
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            ...(init.headers || {}),
          },
          redirect: "follow",
        });
        if (res.status === 403 || res.status === 429 || res.status >= 500) {
          if (attempt < retries) {
            const backoff = Math.min(2000 * Math.pow(2, attempt), 30000) + Math.floor(Math.random() * 500);
            console.log(`  [Quicklly] HTTP ${res.status} ${url} — retry ${attempt + 1}/${retries} in ${(backoff / 1000).toFixed(1)}s`);
            await delay(backoff);
            continue;
          }
          throw new Error(`Quicklly HTTP ${res.status} ${url}`);
        }
        if (!res.ok) throw new Error(`Quicklly HTTP ${res.status} ${url}`);
        return await res.text();
      } catch (err) {
        if ((err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || /network|socket/i.test(err.message))
            && attempt < retries) {
          await delay(Math.min(2000 * Math.pow(2, attempt), 20000));
          continue;
        }
        throw err;
      }
    }
  }
  httpGet(url) { return this.http(url, { method: "GET" }); }
  httpPost(url, body) {
    return this.http(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  // Disk cache — keyed by URL slug. Returns cached body if present; otherwise fetches
  // and writes. Used for both sitemaps and listing pages.
  async cachedGet(url, cachePath) {
    try {
      const body = await fs.promises.readFile(cachePath, "utf8");
      return body;
    } catch {}
    const body = await this.httpGet(url);
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(cachePath, body);
    return body;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SITEMAP DISCOVERY — extract this merchant's subcats + delivery locations.
  // ═══════════════════════════════════════════════════════════════════════════════

  cacheNameForUrl(url) {
    return url.replace(/^https?:\/\//, "").replace(/[\/?&=]/g, "_");
  }

  extractLocs(xml) {
    const out = [];
    const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
    return out;
  }

  // Recursively flatten the sitemap index → list of leaf sitemap URLs.
  async loadSitemapLeaves() {
    const seen = new Set();
    const queue = [SITEMAP_INDEX, ...EXTRA_SITEMAPS];
    const leaves = [];
    while (queue.length) {
      const u = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      const xml = await this.cachedGet(u, path.join(this.sitemapDir, this.cacheNameForUrl(u) + ".xml"));
      this.stats.sitemapsRead++;
      if (/<sitemapindex/i.test(xml)) {
        for (const c of this.extractLocs(xml)) queue.push(c);
      } else {
        leaves.push({ url: u, xml });
      }
    }
    return leaves;
  }

  async loadMerchantContext() {
    if (this.merchantContext) return this.merchantContext;
    console.log(`  [Quicklly] Loading sitemaps to find merchant=${this.merchantSlug}'s subcats + locations...`);
    const leaves = await this.loadSitemapLeaves();
    const subcats = new Set();
    const locations = new Set();
    for (const { xml } of leaves) {
      for (const url of this.extractLocs(xml)) {
        let parts;
        try { parts = new URL(url).pathname.replace(/^\/|\/$/g, "").split("/"); }
        catch { continue; }
        // /indian-grocery/<loc>/<merchant>/<subcat>
        if (parts[0] === "indian-grocery" && parts.length === 4 && parts[2] === this.merchantSlug) {
          locations.add(parts[1]);
          subcats.add(parts[3]);
        }
        // /indian-grocery-store/<loc>/<merchant>  -- also captures locations
        if (parts[0] === "indian-grocery-store" && parts.length >= 3 && parts[2] === this.merchantSlug) {
          locations.add(parts[1]);
        }
      }
    }
    if (subcats.size === 0) {
      throw new Error(`[Quicklly] merchant '${this.merchantSlug}' not found in sitemaps`);
    }
    const firstLoc = [...locations][0];
    this.merchantContext = {
      subcats: [...subcats].sort(),
      locations: [...locations].sort(),
      firstLoc,
    };
    console.log(`  [Quicklly] Merchant ${this.merchantSlug}: ${this.merchantContext.subcats.length} subcats, ${this.merchantContext.locations.length} locations`);
    return this.merchantContext;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ID DISCOVERY — for each subcat, fetch one listing page to extract
  // (subcaid, catid, storeid). The storeid is the same per merchant; we extract it
  // from the first probe and cache it.
  // ═══════════════════════════════════════════════════════════════════════════════

  async discoverIds() {
    const { subcats, firstLoc } = this.merchantContext;
    const subcaidByCat = new Map();   // subcat slug → { subcaid, catid, subcatName }

    // Probe one page first to extract storeid (canonical per merchant).
    // Some merchants don't populate the `storeid: 'NNN'` JS literal on subcat listing
    // pages — Quicklly just leaves data-storeid="" empty there. For those, the store-
    // LANDING page (/indian-grocery-store/<loc>/<merchant>) reliably renders the
    // numeric id on its nav links (data-storeid="NNN" data-slug="<merchant>").
    // Try the subcat probe first; fall back to the store-landing probe if empty.
    let probeUrl = `${QUICKLLY_ORIGIN}/indian-grocery/${firstLoc}/${this.merchantSlug}/${subcats[0]}`;
    let probeCache = path.join(this.pagesDir, `${this.merchantSlug}-${subcats[0]}.html`);
    let probeHtml = await this.cachedGet(probeUrl, probeCache);
    this.stats.pagesFetched++;
    let sidM = probeHtml.match(/storeid:\s*'(\d+)'/);
    if (!sidM) {
      // Fallback: extract from the store-landing page's nav data-storeid attribute.
      const landingUrl = `${QUICKLLY_ORIGIN}/indian-grocery-store/${firstLoc}/${this.merchantSlug}`;
      const landingCache = path.join(this.pagesDir, `${this.merchantSlug}-_landing.html`);
      console.log(`  [Quicklly] subcat probe had no storeid literal; falling back to landing page ${landingUrl}`);
      const landingHtml = await this.cachedGet(landingUrl, landingCache);
      this.stats.pagesFetched++;
      // Two forms tried: data-storeid="NNN" data-slug="<merchant>"  OR  storeid: 'NNN'
      const slug = this.merchantSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re1 = new RegExp(`data-storeid="(\\d+)"[^>]*data-slug="${slug}"`);
      const re2 = /storeid:\s*'(\d+)'/;
      const m1 = landingHtml.match(re1);
      const m2 = !m1 ? landingHtml.match(re2) : null;
      sidM = m1 || m2;
      if (!sidM) {
        throw new Error(`[Quicklly] could not extract storeid for ${this.merchantSlug} from subcat probe (${probeUrl}) or landing page (${landingUrl})`);
      }
    }
    this.merchantStoreId = sidM[1];
    console.log(`  [Quicklly] Merchant storeid=${this.merchantStoreId}`);

    // Parallel-fetch each subcat's listing page → extract subcaid + catid + nav data
    // (the latter gives us subcategory DISPLAY NAMES from data-catname attributes).
    const subcatNamesGlobal = new Map(); // slug → display name (canonical)

    await mapWithConcurrency(subcats, this.scrapeConcurrency, async (subcat) => {
      const url = `${QUICKLLY_ORIGIN}/indian-grocery/${firstLoc}/${this.merchantSlug}/${subcat}`;
      const cache = path.join(this.pagesDir, `${this.merchantSlug}-${subcat}.html`);
      const html = await this.cachedGet(url, cache);
      this.stats.pagesFetched++;
      const sm = html.match(/subcaid\s*=\s*"(\d+)"/);
      const cm = html.match(/catid\s*=\s*"(\d+)"/);
      // Use the slug as the canonical name — it's stable, clean, and matches the
      // category list the chat's Prompt 1 will emit. (The page <title> is an SEO
      // string that includes the merchant name + city; not what we want.)
      const subcatDisplay = subcat
        .replace(/-/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
      if (sm) {
        subcaidByCat.set(subcat, {
          subcaid: sm[1],
          catid: cm ? cm[1] : "4001",
          subcatName: subcatDisplay,
        });
      }
      // Also harvest store-nav `data-catname` for richer canonical name mapping.
      for (const navM of html.matchAll(/data-catname="([^"]+)"[^>]*catid=(\d+)/g)) {
        // We don't directly use this here, but a future pass could match
        // department names from these attributes.
      }
      if (this.scrapeDelayMs) await delay(this.scrapeDelayMs + Math.floor(Math.random() * this.scrapeDelayMs));
    });

    if (subcaidByCat.size === 0) {
      throw new Error(`[Quicklly] no subcaids discovered for ${this.merchantSlug}`);
    }
    console.log(`  [Quicklly] Discovered subcaids for ${subcaidByCat.size}/${subcats.length} subcats`);
    return subcaidByCat;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRODUCTS API — POST per (catid, subcaid) with pagination beyond the 500-card cap.
  // ═══════════════════════════════════════════════════════════════════════════════

  // Parse all product cards in an API response. Each card carries everything we need
  // in `data-*` attributes (no need to fetch the detail page).
  parseProductCards(html) {
    const out = [];
    // Cards are anchored on `data-pid="N"` — pull each card's outer block and parse fields.
    const cardRe = /data-pid="(\d+)"[\s\S]{0,500}?data-name="([^"]+)"[\s\S]{0,500}?data-price="([^"]+)"[\s\S]{0,500}?data-photo="([^"]*)"/g;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const [, pid, name, price, photo] = m;
      out.push({ pid, name, price, photo });
    }
    // Also collect product link slugs from the surrounding HTML for the handle field.
    // Slugs may contain parens and other URL-safe chars (e.g. "beef-with-bone-(3-4lb)"),
    // so accept anything that isn't a path separator or quote.
    const slugByPid = new Map();
    let lm;
    const cardHandleRe = /href="\/?(?:grocery-store\/|buy-)([^"\/]+)\/(\d+)"/gi;
    while ((lm = cardHandleRe.exec(html)) !== null) {
      slugByPid.set(lm[2], lm[1].trim());
    }
    // The VISIBLE title span carries the full name + pack size (e.g. "Garam Masala( 100Gm"),
    // unlike the truncated `data-name` attribute. Map pid → clsTitle so normalizeProduct can use it.
    const clsByPid = new Map();
    let cm;
    const clsRe = /(?:grocery-store\/|buy-)[^"]*\/(\d+)"[\s\S]{0,80}?<span class="clsTitle">([^<]+)<\/span>/gi;
    while ((cm = clsRe.exec(html)) !== null) {
      if (!clsByPid.has(cm[1])) clsByPid.set(cm[1], cm[2].replace(/\s+/g, " ").trim());
    }
    for (const card of out) {
      card.handle = slugByPid.get(card.pid) || "";
      card.fullTitle = clsByPid.get(card.pid) || "";   // richer than data-name (has the pack size)
    }
    return out;
  }

  async fetchSubcatProducts(subcat, subcaid, catid) {
    const collected = new Map();
    let start = 0;
    let page = 0;
    while (true) {
      const body =
        `subcat_id=${subcaid}&catid=${catid}` +
        `&filterstore=&filterbrand=&filterdiscount=&filtersortby=&filteraction=` +
        `&storeid=${this.merchantStoreId}&limit=500&start=${start}`;
      const cache = path.join(this.apiDir, `${this.merchantSlug}-${subcat}-${start}.html`);
      let html;
      try {
        html = await fs.promises.readFile(cache, "utf8");
      } catch {
        html = await this.httpPost(PRODUCTS_API, body);
        await fs.promises.mkdir(path.dirname(cache), { recursive: true });
        await fs.promises.writeFile(cache, html);
        this.stats.apiCalls++;
        if (this.scrapeDelayMs) await delay(this.scrapeDelayMs + Math.floor(Math.random() * this.scrapeDelayMs));
      }
      const cards = this.parseProductCards(html);
      const before = collected.size;
      for (const c of cards) {
        if (!collected.has(c.pid)) collected.set(c.pid, c);
      }
      page++;
      if (cards.length < 500 || collected.size === before || page >= this.maxPagesPerSubcat) break;
      start += 500;
    }
    return [...collected.values()];
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NORMALIZE — title parsing, brand/pack/aliases, then map to BaseProvider shape.
  // ═══════════════════════════════════════════════════════════════════════════════

  normalizeTitle(title) {
    return title.replace(DEPT_PREFIX_RE, "").replace(/\s+/g, " ").trim();
  }

  extractBrand(title) {
    const lower = title.toLowerCase().replace(DEPT_PREFIX_RE, "");
    for (const b of BRAND_TOKENS) {
      if (lower.startsWith(b + " ") || lower === b) {
        // Pretty-case the brand back from the original title segment when possible.
        const orig = title.replace(DEPT_PREFIX_RE, "").slice(0, b.length);
        return orig || b;
      }
    }
    // Fallback: first capitalized word — but only if it isn't a generic
    // meat/fish/descriptor word that masquerades as a brand.
    const m = title.replace(DEPT_PREFIX_RE, "").match(/^([A-Z][A-Za-z0-9.&'-]+)/);
    if (!m) return null;
    if (NON_BRAND_FIRST_WORDS.has(m[1].toLowerCase())) return null;
    return m[1];
  }

  extractPackSize(title) {
    const m = title.match(PACK_RE);
    if (!m) return null;
    const low = m[1];
    const high = m[2];
    const unit = normalizeUnit(m[3]);
    return high ? `${low}-${high} ${unit}` : `${low} ${unit}`;
  }

  // The clsTitle is "<name> <pack>" and Quicklly truncates names at the first "(". For the DISPLAY
  // title we drop the trailing pack token (kept separately in pack_size) and repair the dangling
  // "(" — balanced parentheses (e.g. "(Pouch)", "(3-4lb)") are left intact.
  cleanDisplayTitle(raw) {
    let t = String(raw || "").replace(/\s+/g, " ").trim();
    const ms = [...t.matchAll(new RegExp(PACK_RE.source, "gi"))];
    if (ms.length) {
      const last = ms[ms.length - 1];
      if (last.index + last[0].length >= t.length - 2) t = t.slice(0, last.index).trim();
    }
    if ((t.split("(").length - 1) > (t.split(")").length - 1)) {
      t = t.replace(/\(\s*$/, "").trim();
      if ((t.split("(").length - 1) > (t.split(")").length - 1)) t = t.replace(/\(/g, "").trim();
    }
    return t.replace(/\s+/g, " ").trim();
  }

  // After removing brand + pack_size, what's left is the product noun: "moong dal",
  // "curry powder", etc. Lowercased, whitespace-normalized. If stripping leaves
  // a garbled fragment (empty parens, dangling dashes, just punctuation), fall
  // back to the full-cleaned title — better noisy than empty.
  extractProductType(title, brand, packSize) {
    let s = title.replace(DEPT_PREFIX_RE, "");
    if (brand) {
      const re = new RegExp("^\\s*" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      s = s.replace(re, "");
    }
    // Strip the FULL pack-size match (including range) from the noun.
    s = s.replace(PACK_RE, "");
    // Clean up leftover punctuation from parenthesized sizes:
    //   "beef with bone ()" → "beef with bone"
    //   "lotia - " → "lotia"
    //   "anchovy ()" → "anchovy"
    s = s.replace(/\(\s*[-–\s]*\)/g, "");        // strip empty/dash-only parens
    s = s.replace(/\s*[-–]\s*$/g, "");           // strip trailing dashes
    s = s.replace(/^\s*[-–]\s*/g, "");           // strip leading dashes
    s = s.replace(/\s+/g, " ").trim().toLowerCase();
    // Detect garbled-noun cases:
    //   "(3-)", "()", "(2 t0 )", "(1.5-)", "- bombay duck (frozen ...)" with leading dash
    const garbled = /^\s*[\-(]?\s*$|^\s*\(\s*[\d.\-\s]*\)\s*$|^\s*[\-–]\s|^\s*\(\s*\)\s*$/.test(s)
                 || /^\s*\(?[\d.\-\s]+\)?\s*$/.test(s);
    if (garbled || s.length < 2) {
      // Fall back: title minus brand, but KEEP the noun even if parens are weird.
      let fb = title.replace(DEPT_PREFIX_RE, "");
      if (brand) {
        const re = new RegExp("^\\s*" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
        fb = fb.replace(re, "");
      }
      s = fb.replace(/\s+/g, " ").trim().toLowerCase();
    }
    return s;
  }

  aliasesFor(title, subcategorySlug) {
    const lower = title.toLowerCase();
    const out = new Set();
    // Word-boundary match per alias key — prevents "paya" from matching "payable",
    // "koi" matching "koipond", etc.
    for (const [key, english] of Object.entries(ALIASES)) {
      const re = ALIAS_REGEX.get(key);
      if (!re) continue;
      if (re.test(lower) || lower.includes(english)) {
        out.add(key);
        for (const word of english.split(/\s+/)) out.add(word);
      }
    }
    // Subcategory-driven fallback — applies "fish seafood" anchor to every product
    // in `sea-food`, "poultry meat" to `chicken-products`, etc.
    if (subcategorySlug && SUBCATEGORY_ALIASES[subcategorySlug]) {
      for (const word of SUBCATEGORY_ALIASES[subcategorySlug].split(/\s+/)) {
        out.add(word);
      }
    }
    return [...out].join(" ");
  }

  normalizeProduct(card, ctx) {
    const { subcat, subcatName, catid, subcaid } = ctx;
    // Defensive title normalization: collapse whitespace, trim. Catches edge cases
    // like "Beef with bone  (3-4Lb)" (double space) before any downstream processing.
    // Prefer the visible clsTitle (full name + pack size) over the truncated data-name attribute;
    // fall back to data-name when no clsTitle was captured. Pack comes from the raw title (which
    // still has it); the display title drops the pack and repairs Quicklly's dangling "(".
    const rawTitle = (card.fullTitle || card.name || "").replace(/\s+/g, " ").trim();
    const packSize = this.extractPackSize(rawTitle);
    const title = this.cleanDisplayTitle(rawTitle);
    const titleNormalized = this.normalizeTitle(title).toLowerCase();
    const brand = this.extractBrand(title);
    const productType = this.extractProductType(title, brand, packSize);
    const aliases = this.aliasesFor(title, subcat);
    const price = parseFloat(card.price) || null;

    const id = storePrefixedId(this.shopName, card.pid);
    const variantId = `${id}-default`;

    // Subcategory display name — falls back to slug-pretty if we couldn't extract one.
    const displayName = subcatName || subcat.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    // Collections: subcategory first (the canonical leaf); department (catid 4001 = "Grocery", etc.)
    // could be added once we map catid → name from the merchant landing nav. For v1, just leaf.
    const collections = [
      { id: subcat, title: displayName, handle: subcat },
    ];

    // URL-safe handle: strip parens/special chars. Quicklly's slug includes "(3-4lb)"
    // which is fine for their app but unsafe for our cached URLs / routes.
    const rawHandle = card.handle || `quicklly-${card.pid}`;
    const handle = rawHandle.replace(/[()]/g, "").replace(/--+/g, "-").replace(/^-|-$/g, "");

    // Broken-image detection: .crdownload is a Chrome partial download artifact;
    // these URLs 404 in production. Drop to null so the UI can render a placeholder.
    const imageRaw = card.photo || null;
    const image = (imageRaw && /\.crdownload$/i.test(imageRaw)) ? null : imageRaw;

    // body_html feeds contentEmbedding (base.js: content = `${title}. ${body_html}`).
    // We want enrichment text here (category + aliases) so contentEmbedding captures
    // the species/category anchor and any Hindi/English synonyms.
    const bodyEnrichment = [displayName, aliases].filter(Boolean).join(". ");

    const product = {
      id,
      sku: String(card.pid),
      quicklly_product_id: String(card.pid),
      storeId: this.shopName,

      title,
      title_normalized: titleNormalized,
      body_html: this.descriptionSkip ? bodyEnrichment : "",
      descriptionHtml: this.descriptionSkip ? bodyEnrichment : "",
      handle,

      vendor: brand || "",
      brand: brand || "",
      pack_size: packSize || "",
      product_type: productType || displayName.toLowerCase(),
      aliases_text: aliases || "",

      image,
      images: image ? [{ src: image, alt: title }] : [],

      price,
      currency: "USD",
      status: "active",
      published_at: null,
      tags: "",
      tagsAsCategories: false,

      // Subcat denormalized on the product for fast filtering in chat queries.
      subcategory_slug: subcat,
      subcategory_name: displayName,
      department_slug: null,    // could be filled if we extract catid → catname from the merchant landing nav
      department_name: null,

      merchant_slug: this.merchantSlug,
      merchant_name: this.merchantSlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      merchant_storeid: this.merchantStoreId,

      variants: [
        {
          id: variantId,
          title: "Default",
          price: price ?? 0,
          compare_at_price: null,
          sku: String(card.pid),
          inventory_quantity: 1,
        },
      ],
      options: [],
      collections,
      categoryHierarchy: true,                  // store-namespaced :Category nodes

      metafields: [
        { key: "quicklly_product_id", value: String(card.pid),          namespace: "quicklly" },
        { key: "merchant_slug",       value: this.merchantSlug,         namespace: "quicklly" },
        { key: "merchant_storeid",    value: String(this.merchantStoreId), namespace: "quicklly" },
        { key: "subcaid",             value: String(subcaid),           namespace: "quicklly" },
        { key: "catid",               value: String(catid),             namespace: "quicklly" },
        { key: "in_stock",            value: "true",                    namespace: "quicklly" },
        ...(this.fallbackLocationMetafield
          ? [{ key: "delivers_to", value: (this.merchantContext.locations || []).join(","), namespace: "quicklly" }]
          : []),
      ],

      detectedDemographics: [],  // no gender for grocery → no HAS_DEMOGRAPHIC edges
    };
    return product;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DISCOVER — run once on the first fetchProducts() call.
  // Loads merchant context → discovers ids → calls API for every subcat → normalizes.
  // ═══════════════════════════════════════════════════════════════════════════════

  async discover() {
    await this.loadMerchantContext();
    const subcaidByCat = await this.discoverIds();

    // Hit the API for each subcat (with pagination + dedup).
    const subcatList = [...subcaidByCat.entries()];
    const allCards = await mapWithConcurrency(subcatList, this.scrapeConcurrency, async ([subcat, ids]) => {
      const cards = await this.fetchSubcatProducts(subcat, ids.subcaid, ids.catid);
      return { subcat, ids, cards };
    });

    // Normalize, dedup by pid (a product can appear in multiple subcats — keep first).
    const seen = new Set();
    const normalized = [];
    for (const { subcat, ids, cards } of allCards) {
      for (const card of cards) {
        if (seen.has(card.pid)) continue;
        seen.add(card.pid);
        normalized.push(this.normalizeProduct(card, {
          subcat,
          subcatName: ids.subcatName,
          subcaid: ids.subcaid,
          catid: ids.catid,
        }));
      }
    }
    this.normalizedProducts = normalized;
    this.stats.products = normalized.length;
    console.log(`  [Quicklly] Discovered ${normalized.length} unique products for ${this.merchantSlug} (${this.stats.apiCalls} API calls, ${this.stats.pagesFetched} pages)`);

    // QA hook: when QUICKLLY_DUMP_JSON is set, dump every normalized product PLUS
    // the exact strings that will go into the 4 embeddings (computed the same way
    // base.js + extractProductProperties build them). Pure debug — no pipeline effect.
    if (process.env.QUICKLLY_DUMP_JSON) {
      const dump = await Promise.all(normalized.map(async (p) => {
        const props = await this.extractProductProperties("", p);
        const content = `${p.title}. ${p.body_html || ""}`;
        return {
          id: p.id, pid: p.quicklly_product_id, title: p.title,
          title_normalized: p.title_normalized, brand: p.brand, pack_size: p.pack_size,
          product_type: p.product_type, aliases_text: p.aliases_text,
          subcategory_slug: p.subcategory_slug, subcategory_name: p.subcategory_name,
          handle: p.handle, price: p.price, image: p.image,
          // Reflect what base.js will actually embed:
          embed_title: p.title,                  // base.js feeds `product.title` verbatim
          embed_content: content,                 // `${title}. ${body_html}` — body_html is enrichment
          embed_product: props.product,           // from extractProductProperties.product
          embed_characteristics: props.characteristics, // from extractProductProperties.characteristics
        };
      }));
      await fs.promises.writeFile(process.env.QUICKLLY_DUMP_JSON, JSON.stringify(dump, null, 2));
      console.log(`  [Quicklly] Dumped ${dump.length} normalized products to ${process.env.QUICKLLY_DUMP_JSON}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BASEPROVIDER INTERFACE — fetchProducts (cursor) / fetchCollections / getShopData
  // ═══════════════════════════════════════════════════════════════════════════════

  async fetchProducts(options = {}) {
    if (this.normalizedProducts === null) {
      await this.discover();
      this.cursorIndex = 0;
    }
    const start = options.cursor != null ? parseInt(options.cursor, 10) : this.cursorIndex;
    const limit = options.limit || 20;
    const batch = this.normalizedProducts.slice(start, start + limit);
    this.cursorIndex = start + batch.length;
    const hasNextPage = this.cursorIndex < this.normalizedProducts.length;
    return {
      products: batch,
      nextCursor: hasNextPage ? String(this.cursorIndex) : null,
      hasNextPage,
    };
  }

  async fetchCollections() {
    // We use categoryHierarchy=true on each product — :Category nodes are created
    // per-product through the store-namespaced path. Returning [] skips the flat
    // global Category MERGE in BaseProvider.syncProducts.
    return [];
  }

  async getShopData() {
    return {
      currency: "USD",
      name: this.merchantSlug,
      domain: "quicklly.com",
      // Locations the merchant serves — consumed by a writer extension that creates
      // :Location nodes + :DELIVERS_TO edges. Once neo4j.js has that, the writer
      // will pick this up automatically (it's harmless if the writer ignores it).
      deliveryLocations: this.merchantContext?.locations || [],
      merchantStoreId: this.merchantStoreId,
      merchantSlug: this.merchantSlug,
    };
  }

  // Cursor state — enables resume across runs (BaseProvider calls this).
  getCursorState() {
    return { cursorIndex: this.cursorIndex, stats: { ...this.stats } };
  }
  restoreCursorState(state) {
    if (!state) return;
    this.cursorIndex = state.cursorIndex || 0;
    if (state.stats) this.stats = { ...this.stats, ...state.stats };
    console.log(`  [Quicklly] Restored cursor: index ${this.cursorIndex}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BASEPROVIDER OVERRIDES — grocery defaults (mirror Bringo).
  // ═══════════════════════════════════════════════════════════════════════════════

  // No garment color for grocery.
  async detectColorFromImage() { return null; }

  // No fashion classifier — derive search attributes deterministically from scraped fields.
  //
  // The four base-pipeline embeddings end up being:
  //   - titleEmbedding         = product.title             (verbatim, set in base.js)
  //   - contentEmbedding       = `${title}. ${body_html}`  (body_html is enrichment, set in normalizeProduct)
  //   - productEmbedding       = props.product             (this method's `product` field)
  //   - characteristicsEmbedding = props.characteristics   (this method's `characteristics` field)
  //
  // Goal here is to make `product` and `characteristics` carry the SPECIES/CATEGORY
  // anchor + aliases + pack_size, WITHOUT the fake brand token that would
  // double-pollute when brand is just the first word of the title (e.g. "Beef Boneless").
  async extractProductProperties(_content, product) {
    const leaf = product.subcategory_name ||
      (product.collections?.length ? product.collections[product.collections.length - 1].title : "") ||
      product.product_type || product.title || "";
    // Anchor = subcategory minus generic suffixes ("Beef Products" → "beef")
    const anchor = leaf.toLowerCase().replace(/\s+(products?|food)$/i, "").trim();

    // embed_product: species/category anchor + product noun. Even when product_type
    // is mangled, the anchor ensures the species token is present.
    const productText = [anchor, product.product_type, product.title_normalized]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)  // dedup token-by-token (very rough)
      .join(" ")
      .trim();

    // embed_characteristics: title-normalized + size + halal hint + aliases.
    // Drop the bogus brand — it was just the title's first word for 97/97 of bangladesh.
    const hints = [];
    if (product.pack_size) hints.push(product.pack_size);
    if (/\bhalal\b/i.test(product.title || "")) hints.push("halal");
    // Only include a "real" brand (matched a KNOWN_BRANDS entry, not the title-first-word
    // fallback). Heuristic: if the brand is the EXACT first word of the title, it's
    // probably the fallback and we drop it. Otherwise it survived a real match.
    const firstTitleWord = (product.title || "").split(/\s+/)[0] || "";
    const isRealBrand = product.brand && product.brand.toLowerCase() !== firstTitleWord.toLowerCase();
    if (isRealBrand) hints.unshift(product.brand);
    const characteristicsText = [product.title_normalized, ...hints, product.aliases_text]
      .filter(Boolean).join(", ");

    return {
      product: productText || "unknown",
      characteristics: characteristicsText || "unknown",
      color: "",
      material: "",
      demographic: "",
      category: leaf,
    };
  }

  // Leaf is the canonical subcategory (not the merchant department).
  determineCategory(product) {
    if (product.collections && product.collections.length) {
      return product.collections[product.collections.length - 1].title;
    }
    return product.product_type || product.title || "";
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════════════

  async sync() {
    console.log(`\n=== Starting ${this.providerType} Sync for ${this.shopName} ===`);
    console.log(`  [Quicklly] Merchant: ${this.merchantSlug}\n`);

    // Lazy-load merchant context (sitemap walk + subcat list + delivery locations)
    // so we have the location list ready.
    if (!this.dryRun) {
      try {
        await this.loadMerchantContext();
      } catch (e) {
        console.error(`  [Quicklly] Discovery failed:`, e.message);
      }
    }

    // BaseProvider.sync() creates :Store + :Application via createApplicationAndStore
    // and writes all products. We need :Store to exist before linkStoreDelivery, so
    // wrap that call to run AFTER super.sync()'s store-creation step has had a chance
    // to fire. Simplest correct ordering: super.sync() first, then locations/delivery
    // (super.sync() creates the Store on its very first step, so re-using that node
    // is safe; products get linked to it during the long product loop).
    //
    // Subtle: createOrUpdateLocations is safe to run anytime since :Location nodes
    // are independent of :Store. We do it BEFORE super.sync() so the chat handler
    // can answer "is there delivery to X" queries even mid-sync.
    if (!this.dryRun && this.merchantContext) {
      try {
        const locations = (this.merchantContext.locations || []).map(slug => {
          const m = slug.match(/^(.+)-([a-z]{2})$/);
          return m
            ? { slug, city: m[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()), state: m[2].toUpperCase() }
            : { slug };
        });
        await this.neo4j.createOrUpdateLocations(locations);
      } catch (e) {
        console.error(`  [Quicklly] createOrUpdateLocations failed (non-fatal):`, e.message);
      }
    }

    await super.sync();

    // NOW link Store -> Location, after :Store has been created by super.sync().
    if (!this.dryRun && this.merchantContext) {
      try {
        await this.neo4j.linkStoreDelivery(this.shopName, this.merchantContext.locations || []);
      } catch (e) {
        console.error(`  [Quicklly] linkStoreDelivery failed (non-fatal):`, e.message);
      }
    }

    this.logFinalStats();
  }

  logFinalStats() {
    console.log("\n  ════════════════════════════════════════════════════════════");
    console.log("  [Quicklly] SCRAPE STATS:");
    console.log(`    Sitemaps read:        ${this.stats.sitemapsRead}`);
    console.log(`    Listing pages fetched:${this.stats.pagesFetched}`);
    console.log(`    API calls:            ${this.stats.apiCalls}`);
    console.log(`    Products discovered:  ${this.stats.products}`);
    console.log(`    Subcats:              ${this.merchantContext?.subcats.length || 0}`);
    console.log(`    Delivery locations:   ${this.merchantContext?.locations.length || 0}`);
    console.log(`    Merchant storeid:     ${this.merchantStoreId}`);
    console.log("  ════════════════════════════════════════════════════════════\n");
  }
}

export default QuicklyProvider;
