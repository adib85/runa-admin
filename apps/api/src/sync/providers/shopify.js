/**
 * Shopify Provider
 * Implementation of BaseProvider for Shopify stores
 * Includes shop-specific features for Bogas, DyFashion, and Raicu
 */

import { GraphQLClient, gql } from "graphql-request";
import { normalizeCanonicalColor } from "../services/detect-canonical-color.js";
import Shopify from "shopify-api-node";
import fetch from "node-fetch";
import { stripHtml } from "string-strip-html";
import { config as runaConfig } from "@runa/config";
import { BaseProvider } from "./base.js";
import { s3Service, openaiService } from "../services/index.js";
import { convertHtmlToMarkdown, extractRelevantFields, delay } from "../utils/index.js";
import { normalizeStyleFilters, buildSizeChartJson, extractMaterials } from "../utils/style-filters.js";

// ─── Bronze Snake collection-handle taxonomy ─────────────────────────────────
// Shared between `detectBronzeSnakeDemographic` and `determineBronzeSnakeCategory`
// so both functions agree on which `mens-*` / `womens-*` handles are real
// gender signals vs. smart filters / admin buckets.
const BS_ADMIN_HANDLES = new Set([
  "gift-cards", "doesnt-include-gift-cards",
  "mens", "mens-1", "womens", "womens-1",
  "mens-new", "mens-back-in-stock", "mens-coming-soon",
  "womens-new", "womens-just-landed", "womens-back-in-stock", "womens-coming-soon",
]);
const BS_GENERIC_HANDLES = new Set(["mens-accessories", "womens-accessories"]);
// Color smart collections (e.g. mens-ivory, womens-cream) auto-include
// products of that color regardless of actual gender. Don't include real
// category words like "denim".
const BS_COLOR_SUFFIXES = new Set([
  "black", "white", "ivory", "cream", "beige", "brown", "chocolate", "tan",
  "grey", "gray", "navy", "blue", "red", "pink", "green", "olive", "khaki",
  "yellow", "orange", "purple", "wine", "burgundy", "mocha", "stone", "sage",
  "earth", "rust", "camel", "natural", "nude", "sand",
]);
const BS_HANDLE_TYPO_FIX = {
  "womens-acccessories": "womens-accessories",
  "mens-accesories": "mens-accessories",
  "men-accessories": "mens-accessories",
};

// Shopify option names that carry the product's color (used to read the real
// product color from a variant's selectedOptions).
const COLOR_OPTION_NAMES = new Set(["color", "colour", "culoare"]);

function isBronzeSnakeAdminHandle(h) {
  return BS_ADMIN_HANDLES.has(h)
    || /(^|-)just-landed$/.test(h)
    || /-back-in-stock$/.test(h)
    || /-coming-soon$/.test(h)
    || /-sale$/.test(h)
    || /-\d+$/.test(h)
    || BS_COLOR_SUFFIXES.has(h.replace(/^(mens|womens)-/, ""));
}

const GET_PRODUCTS_QUERY = gql`
  query getProducts($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id title descriptionHtml handle vendor productType status tags publishedAt
          images(first: 10) { edges { node { src altText } } }
          variants(first: 100) {
            edges {
              node {
                id title price compareAtPrice sku inventoryQuantity inventoryPolicy
                selectedOptions { name value }
              }
            }
          }
          collections(first: 10) { edges { node { id title handle } } }
          metafields(first: 10) { edges { node { key value namespace } } }
          styleFilters: metafield(namespace: "custom", key: "style_filters_new") { value type }
          canonicalColorMeta: metafield(namespace: "customAttributes", key: "colour") { value }
          relatedColourwaysMeta: metafield(namespace: "custom", key: "related_colourways") { value }
          sizeBustMeta: metafield(namespace: "custom", key: "size_bust") { value }
          sizeWaistMeta: metafield(namespace: "custom", key: "size_waist") { value }
          sizeHipMeta: metafield(namespace: "custom", key: "size_hip") { value }
          sizeLengthMeta: metafield(namespace: "custom", key: "size_length") { value }
          sizeTopLengthMeta: metafield(namespace: "custom", key: "size_top_length") { value }
          sizePantLengthMeta: metafield(namespace: "custom", key: "size_pant_length") { value }
          sizeSkirtLengthMeta: metafield(namespace: "custom", key: "size_skirt_length") { value }
          sizeShortLengthMeta: metafield(namespace: "custom", key: "size_short_length") { value }
          sizeSleeveLengthMeta: metafield(namespace: "custom", key: "size_sleeve_length") { value }
          sizeInseamMeta: metafield(namespace: "custom", key: "size_inseam") { value }
          sizePitToPitMeta: metafield(namespace: "custom", key: "size_pit_to_pit") { value }
        }
      }
    }
  }
`;

export class ShopifyProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.endpoint = `https://${this.shopName}/admin/api/${runaConfig.shopify.apiVersion}/graphql.json`;
    this.graphQLClient = new GraphQLClient(this.endpoint, {
      headers: {
        "X-Shopify-Access-Token": this.accessToken,
        "Content-Type": "application/json"
      }
    });
    this.shopifyApi = new Shopify({ shopName: this.shopName, accessToken: this.accessToken });
    this.descriptionLanguage = "en";
    this.defaultConcurrency = 10;
    this.geminiModel = config.geminiModel || runaConfig.gemini.liteModel || runaConfig.gemini.model;
    this.skipGrounding = true;
    this.productQueryFilter = this.getProductQueryFilter();

    this.stats = {
      totalFetched: 0,
      withDescription: 0,
      withoutDescription: 0,
      withImages: 0,
      withoutImages: 0,
      totalVariants: 0,
      zeroInventory: 0
    };
  }

  get providerType() {
    return "Shopify";
  }

  // Real-inventory "in stock" signal (overrides BaseProvider's always-true default).
  // A product is in stock if ANY variant is sellable: positive tracked inventory, set to
  // "continue selling when out of stock" (inventoryPolicy CONTINUE → still purchasable),
  // or untracked inventory (inventory_quantity null). Mirrors the out-of-stock report so we
  // never flag a backorderable / untracked product as sold out. Written to p.inStock on
  // every product each sync (see BaseProvider.fetchAndProcessProducts) and consumed by the
  // chat / Complete-the-Look / Similar candidate filters via coalesce(p.inStock, true).
  computeInStock(product) {
    const variants = product.variants || [];
    if (variants.length === 0) return true; // no variant data → don't hide
    return variants.some(v =>
      (typeof v.inventory_quantity === "number" && v.inventory_quantity > 0) ||
      v.inventory_policy === "CONTINUE" ||
      v.inventory_quantity == null
    );
  }

  async fetchProducts(options = {}) {
    const { cursor, limit = 50 } = options;
    
    const effectiveCursor = cursor || this._resumeCursor || null;
    this._resumeCursor = null;

    let batchSize = limit;
    if (this.shopName === "andreearaicu.myshopify.com") {
      batchSize = 2;
    }

    // Bronze Snake visibility is decided ENTIRELY by the Admin API query filter
    // (status:active AND published_status:published — see getProductQueryFilter), which
    // returns every product published to the Online Store. Verified: that set is a
    // superset containing 100% of storefront /collections/all (0 misses). The old
    // /collections/all storefront scrape was REMOVED — it was a flaky public-CDN feed
    // that silently truncated on throttling, dropping valid in-stock products from the
    // index (and, via the nightly cleanup, risked DELETING them). Out-of-stock is handled
    // by p.inStock; dupe/admin/numbered handles by isBronzeSnakeAdminHandle below.
    let queryStr = this.productQueryFilter || "status:active";
    if (this.sinceIso) {
      queryStr += ` AND updated_at:>=${this.sinceIso}`;
    }

    const response = await this.graphQLClient.request(GET_PRODUCTS_QUERY, {
      first: batchSize,
      after: effectiveCursor,
      query: queryStr
    });

    const products = this.transformGraphQLResponse(response);
    
    if (this.shopName === "andreearaicu.myshopify.com") {
      await this.fetchRaicuTranslations(products);
    }

    const nextCursor = response.products.pageInfo.hasNextPage 
      ? response.products.edges[response.products.edges.length - 1].cursor 
      : null;
    this._lastCursor = nextCursor;

    return {
      products,
      nextCursor,
      hasNextPage: response.products.pageInfo.hasNextPage
    };
  }

  transformGraphQLResponse(response) {
    return response.products.edges.map(edge => {
      const node = edge.node;

      // Bronze Snake: skip admin/utility/numbered/color-suffix DUPLICATE handles
      // (e.g. "…-coming-soon", "…-sale", "…-back-in-stock", "…-1", color-variant dupes).
      // This filtering used to happen while building the storefront handle set; now that
      // the storefront scrape is gone, we apply it directly here. Everything else that is
      // status:active AND published_status:published gets indexed; p.inStock handles OOS.
      if (this.shopName === "bronze-snake-1.myshopify.com" && isBronzeSnakeAdminHandle(node.handle)) {
        return null;
      }

      const id = node.id.replace("gid://shopify/Product/", "");

      const images = node.images?.edges?.map(e => ({ src: e.node.src, alt: e.node.altText })) || [];
      const variants = node.variants?.edges?.map(e => {
        const v = e.node;
        const variantId = v.id.replace("gid://shopify/ProductVariant/", "");
        const options = {};
        v.selectedOptions?.forEach((opt, idx) => {
          options[`option${idx + 1}`] = opt.value;
        });
        return {
          id: variantId,
          title: v.title,
          price: v.price,
          compare_at_price: v.compareAtPrice,
          sku: v.sku,
          inventory_quantity: v.inventoryQuantity,
          inventory_policy: v.inventoryPolicy,
          ...options
        };
      }) || [];

      this.stats.totalFetched++;
      this.stats.totalVariants += variants.length;
      if (node.descriptionHtml?.trim()) this.stats.withDescription++;
      else this.stats.withoutDescription++;
      if (images.length > 0) this.stats.withImages++;
      else this.stats.withoutImages++;
      const totalStock = variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
      if (totalStock <= 0) this.stats.zeroInventory++;

      // The real product color = the "Color"/"Colour" option value (e.g.
      // "Deep Ocean"). Bronze Snake products are single-color (color is at
      // product level, only size varies), so the first variant's color option
      // is the product color. Single-variant items (e.g. fragrances) have no
      // Color option and fall back to the colour metafield (see resolveProductColorValue).
      let shopifyColorOption = null;
      for (const e of (node.variants?.edges || [])) {
        const opt = (e.node.selectedOptions || []).find(o => COLOR_OPTION_NAMES.has((o.name || "").toLowerCase()));
        if (opt?.value) { shopifyColorOption = opt.value; break; }
      }

      // Product-level numeric price = MIN of variant prices. Single number
      // (no currency carry-through, no min/max range) so downstream queries
      // can filter/sort with `p.price <= 150`. null when no variant has a
      // numeric price (or no variants).
      const numericPrices = variants
        .map(v => parseFloat(v.price))
        .filter(n => Number.isFinite(n));
      const price = numericPrices.length ? Math.min(...numericPrices) : null;

      // Sale state: lowest compare-at among variants; on sale when it beats the price.
      const numericCompareAt = variants
        .map(v => parseFloat(v.compare_at_price))
        .filter(n => Number.isFinite(n) && n > 0);
      const priceOld = numericCompareAt.length ? Math.min(...numericCompareAt) : null;

      const product = {
        id,
        title: node.title,
        body_html: node.descriptionHtml,
        descriptionHtml: node.descriptionHtml,
        handle: node.handle,
        vendor: node.vendor,
        product_type: node.productType,
        status: node.status?.toLowerCase(),
        tags: node.tags?.join(", ") || "",
        tagsAsCategories: false,
        published_at: node.publishedAt,
        price,
        price_old: priceOld,
        onSale: priceOld != null && price != null && priceOld > price,
        // Material from the ORIGINAL merchant description (deterministic regex;
        // the backfill's optional Gemini pass handles products this returns null for).
        ...(m => m
          ? { materialDominant: m.dominant, materials: m.materials, materialComposition: m.composition }
          : { materialDominant: null, materials: null, materialComposition: null }
        )(extractMaterials(node.descriptionHtml)),
        // Normalized storefront "Style" filter slugs (custom.style_filters_new).
        // Stored on EVERY product as a plain property for chat hard-filtering —
        // independent of the gated category-edge mechanism below.
        styleFilters: normalizeStyleFilters(node.styleFilters?.value),
        // PDP size table (custom.size_* metafields) as a JSON string; values
        // positionally aligned with the product's size list / sizeTokens.
        sizeChartJson: buildSizeChartJson({
          bust: node.sizeBustMeta?.value,
          waist: node.sizeWaistMeta?.value,
          hip: node.sizeHipMeta?.value,
          length: node.sizeLengthMeta?.value,
          top_length: node.sizeTopLengthMeta?.value,
          pant_length: node.sizePantLengthMeta?.value,
          skirt_length: node.sizeSkirtLengthMeta?.value,
          short_length: node.sizeShortLengthMeta?.value,
          sleeve_length: node.sizeSleeveLengthMeta?.value,
          inseam: node.sizeInseamMeta?.value,
          pit_to_pit: node.sizePitToPitMeta?.value,
        }),
        images,
        variants,
        options: this.extractOptions(node.variants?.edges || []),
        collections: node.collections?.edges?.map(e => ({
          id: e.node.id.replace("gid://shopify/Collection/", ""),
          title: e.node.title,
          handle: e.node.handle
        })) || [],
        metafields: node.metafields?.edges?.map(e => ({
          key: e.node.key,
          value: e.node.value,
          namespace: e.node.namespace
        })) || [],
        canonicalColor: normalizeCanonicalColor(node.canonicalColorMeta?.value),
        shopifyColorOption,
        rawColorMeta: node.canonicalColorMeta?.value || null,
        // Same-style/different-color siblings from the `custom.related_colourways`
        // metafield (list.product_reference, self-inclusive). Bare ids, self removed.
        relatedColourways: this.parseRelatedColourways(node.relatedColourwaysMeta?.value, id)
      };

      const demographics = this.detectDemographic(product, node.tags || []);
      if (demographics) product.detectedDemographics = demographics;

      // Bronze Snake: overwrite collection.title with the handle so the
      // Neo4j (:Category) nodes use the slug form (`womens-jackets-coats`)
      // instead of the messy title (`womens: jackets & coats`); and, only
      // for products in `womens-jackets-coats` or `womens-bags-and-shoes`,
      // append the storefront's "Style" filter values (custom.style_filters_new
      // metafield, e.g. "Trench Coats", "Bomber Jackets") as extra category
      // edges (slugified, deduplicated case-insensitively).
      if (this.shopName === "bronze-snake-1.myshopify.com") {
        product.collections = product.collections.map(c => ({
          ...c,
          title: c.handle || c.title,
        }));

        const STYLE_FILTER_PRIMARY_CATEGORIES = new Set([
          "womens-jackets-coats",
          "womens-bags-and-shoes",
          "womens-swim",
        ]);
        const productHandles = new Set(product.collections.map(c => (c.handle || "").toLowerCase()));
        const isInAllowedCategory = [...STYLE_FILTER_PRIMARY_CATEGORIES].some(h => productHandles.has(h));

        if (isInAllowedCategory) {
          const styleSlugs = this.extractBronzeSnakeStyleFilters(node.styleFilters?.value, productHandles);

          // Fallback: products without a useful style metafield still need
          // at least one style slug, because the chatbot's Gemini context
          // doesn't expose the parent `womens-bags-and-shoes` /
          // `womens-jackets-coats` / `womens-swim` categories — every
          // product must be reachable via at least one style category.
          if (styleSlugs.length === 0) {
            const pt = (product.product_type || "").toLowerCase();
            const titleLc = (product.title || "").toLowerCase();
            if (productHandles.has("womens-swim")) {
              // Title-keyword inference for swim, falls through to "swimwear" generic.
              const SWIM_TITLE_RULES = [
                [/bikini.*top|\bbra\b|bandeau/, "bikini-tops"],
                [/bikini.*bottom|\bbottom\b|brief/, "bikini-bottoms"],
                [/one[- ]piece|swimsuit/, "swim-one-piece"],
                [/maxi.*skirt|midi.*skirt|beach.*skirt/, "beach-skirts"],
                // sarong / sheer pant / beach dress / halter dress → swimwear bucket
                [/sarong|sheer.*pant|halter|mini.*dress|short.*sleeve.*dress|beach.*dress|cover[- ]up/, "swimwear"],
              ];
              let inferred = null;
              for (const [re, slug] of SWIM_TITLE_RULES) {
                if (re.test(titleLc)) { inferred = slug; break; }
              }
              styleSlugs.push(inferred || "swimwear");
            } else if (productHandles.has("womens-bags-and-shoes")) {
              if (pt.includes("shoes") || /\b(shoe|heel|boot|loafer|sandal|sneaker|flat|wedge|mule|pump)\b/.test(titleLc)) {
                styleSlugs.push("shoes");
              } else {
                styleSlugs.push("bags");
              }
            } else if (productHandles.has("womens-jackets-coats")) {
              // Title-keyword inference, falls through to "jackets" generic.
              const TITLE_RULES = [
                [/\btrench\b/, "trench-coats"],
                [/\bbomber\b/, "bomber-jackets"],
                [/\bwindbreaker\b/, "windbreakers"],
                [/denim.*jacket/, "denim-jackets"],
                [/leather.*jacket/, "leather-jackets"],
                [/suede.*jacket/, "suede-jackets"],
                [/biker.*jacket/, "biker-jackets"],
                [/\bpuffer\b/, "puffer-jackets"],
                [/\bblazer\b/, "blazers"],
                [/\bcardigan\b/, "knitwear"],
                [/\bshacket\b/, "shackets"],
                [/\bcoat\b/, "coats"],
                [/\bjacket\b/, "jackets"],
                [/\bset\b/, "sets"],
                [/\bknit\b/, "knitwear"],
              ];
              let inferred = null;
              for (const [re, slug] of TITLE_RULES) {
                if (re.test(titleLc)) { inferred = slug; break; }
              }
              styleSlugs.push(inferred || "jackets");
            }
          }

          for (const slug of styleSlugs) {
            if (!product.collections.some(c => (c.handle || c.title) === slug)) {
              product.collections.push({ id: `style-${slug}`, title: slug, handle: slug });
            }
          }
        }
      }

      return product;
    }).filter(p => p !== null);
  }

  // Parses Bronze Snake's `custom.style_filters_new` metafield (a JSON list
  // like `["Trench Coats","Long Coats"]`) into a deduplicated, normalized
  // list of slugified style names. Case variants ("Windbreakers" /
  // "WindBreakers") collapse via lowercase. Synonyms are merged to canonical
  // slugs (e.g. "Cropped Trench" → "trench-coats"). Styles that don't belong
  // in the gated parent category are dropped.
  //
  // contextHandles: Set of the product's collection handles (used to apply
  //   context-specific synonyms — e.g. "Mini Dresses" only collapses to
  //   "beach-dresses" when the product is in `womens-swim`, not when it's
  //   in a regular jackets/coats context).
  extractBronzeSnakeStyleFilters(rawValue, contextHandles = new Set()) {
    if (!rawValue) return [];
    let arr;
    try {
      arr = JSON.parse(rawValue);
    } catch {
      arr = [rawValue];
    }
    if (!Array.isArray(arr)) arr = [arr];

    const isSwim = contextHandles.has("womens-swim");

    // Swim-context overrides — applied first when the product is in womens-swim.
    // Re-uses dress/skirt slugs that mean different things outside swim.
    // Singletons (sarong / sheer pants / beach dress variants) all collapse
    // into `swimwear` so we don't end up with one-product slugs.
    const SWIM_SYNONYMS = {
      "one-piece": "swim-one-piece",
      "midi-skirts": "beach-skirts",
      "maxi-skirts": "beach-skirts",
      // beach cover-ups / pool-side pieces → all consolidated under swimwear
      "mini-dresses": "swimwear",
      "short-sleeve-dresses": "swimwear",
      "halter-neck-dresses": "swimwear",
      "sheer-pants": "swimwear",
      "sarongs": "swimwear",
    };

    // Default synonyms (apply in non-swim contexts).
    const SYNONYMS = {
      // ── jackets/coats ────────────────────────────────────────────────
      "cropped-trench": "trench-coats",
      "trench": "trench-coats",
      "cardigans": "knitwear",
      "sweaters": "knitwear",
      // drop (not jackets/coats — these are other product categories)
      "denim-tops": null,
      "long-sleeve-tops": null,
      "shirts": null,
      "sets": null,
      // ── bags/shoes ───────────────────────────────────────────────────
      "clutch": "clutches",       // singular → plural
      // drop (material, not style)
      "genuine-leather": null,
      // NOTE: "bags" and "shoes" are kept as-is (not dropped) so every
      // product in womens-bags-and-shoes gets at least a generic style
      // category — needed because the chatbot's Gemini context doesn't
      // expose the parent `womens-bags-and-shoes` category directly.
    };

    const slugSet = new Set();
    for (const v of arr) {
      const raw = String(v).trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!raw) continue;
      // Swim-context lookup wins over the default map.
      if (isSwim && raw in SWIM_SYNONYMS) {
        if (SWIM_SYNONYMS[raw] === null) continue;
        slugSet.add(SWIM_SYNONYMS[raw]);
      } else if (raw in SYNONYMS) {
        if (SYNONYMS[raw] === null) continue;
        slugSet.add(SYNONYMS[raw]);
      } else {
        slugSet.add(raw);
      }
    }
    return [...slugSet];
  }

  // DEPRECATED / UNUSED (kept for reference). Fetched product handles from the public
  // storefront /collections/all feed and used them as a visibility gate. Removed because
  // that feed is a flaky public-CDN endpoint that throttles and silently truncates
  // (no retry, `if (!r.ok) break`), so a partial fetch dropped valid in-stock products
  // from the index. Replaced by the Admin API filter `status:active AND
  // published_status:published` (a verified superset of /collections/all) + the
  // isBronzeSnakeAdminHandle dupe filter. No longer called by fetchProducts.
  async fetchStorefrontVisibleHandles() {
    const handles = new Set();
    const domain = this.shopName.replace(/\.myshopify\.com$/, "");
    // Try the canonical custom domain first, fall back to *.myshopify.com
    const hosts = [
      "bronzesnake.com",                  // Bronze Snake's primary domain
      `${domain}.myshopify.com`,
    ];
    for (const host of hosts) {
      handles.clear();
      try {
        let page = 1;
        while (page <= 50) {
          const url = `https://${host}/collections/all/products.json?limit=250&page=${page}`;
          const r = await fetch(url);
          if (!r.ok) break;
          const j = await r.json();
          if (!j.products?.length) break;
          for (const p of j.products) handles.add(p.handle);
          if (j.products.length < 250) break;
          page++;
        }
        if (handles.size > 0) {
          console.log(`  [Shopify] Storefront /collections/all visible handles: ${handles.size} (via ${host})`);
          return handles;
        }
      } catch (e) {
        console.log(`  [Shopify] Failed to fetch storefront handles via ${host}: ${e.message}`);
      }
    }
    console.log(`  [Shopify] Could not load storefront handles — falling back to admin-only filter (no visibility filter applied)`);
    return null;
  }

  extractOptions(variantEdges) {
    if (!variantEdges.length) return [];
    const firstVariant = variantEdges[0].node;
    return (firstVariant.selectedOptions || []).map((opt, idx) => ({
      name: opt.name,
      position: idx + 1
    }));
  }

  async fetchCollections() {
    try {
      const custom = await this.shopifyApi.customCollection.list();
      const smart = await this.shopifyApi.smartCollection.list();
      return [...custom, ...smart].map(c => ({ title: c.title }));
    } catch (e) {
      console.log("Error fetching collections:", e.message);
      return [];
    }
  }

  async getShopData() {
    // Shop-specific currencies
    if (this.shopName.includes("dyfashion")) {
      return { currency: "RON" };
    }

    try {
      const shop = await this.shopifyApi.shop.get();
      return {
        currency: shop.currency || "USD",
        name: shop.name,
        domain: shop.domain
      };
    } catch (e) {
      console.log("Error fetching shop data:", e.message);
      return { currency: "USD" };
    }
  }

  getCursorState() {
    return { graphqlCursor: this._lastCursor || null };
  }

  restoreCursorState(state) {
    if (state?.graphqlCursor) {
      this._resumeCursor = state.graphqlCursor;
      console.log(`  [Shopify] Restored cursor for resume`);
    }
  }

  async detectColorFromImage() {
    return null;
  }

  async classifyBeachCategory() {
    return null;
  }

  // Decides whether to invoke `pickHeroImage` for this product.
  // Bronze Snake-only opt-in: their image arrays often have lookbook/lifestyle
  // shots in the [0] slot, so the AI hero pick is worth the per-product cost.
  // Skips products that already have a heroImage unless `rewriteHeroes` is set.
  // Skips products with < 2 images (single-image case is handled inside
  // pickHeroImage as an early return — this gate is purely an optimization).
  shouldPickHero(product) {
    if (this.shopName !== "bronze-snake-1.myshopify.com") return false;
    const imgCount = (product.images || []).length;
    if (imgCount < 2) return false;
    if (product.heroImage && !this.rewriteHeroes) return false;
    return true;
  }

  // Decides whether to ask Gemini to pick a canonical color for this product.
  // Bronze Snake-only: their storefront color filter is powered by the
  // `customAttributes.colour` metafield (33 buckets). We read it directly in
  // the GraphQL query above; this method only fires when that metafield is
  // missing, so Gemini can fill the gap from the product image + title.
  shouldDetectCanonicalColor(product) {
    if (this.shopName !== "bronze-snake-1.myshopify.com") return false;
    if (product.canonicalColor) return false;
    if (!(product.images || []).length) return false;
    return true;
  }

  // Resolves the value used for the product-level `color` / `colorEmbedding`
  // fields in Neo4j (the recommendation/search color-similarity signal).
  // Bronze Snake-only: returns the REAL product color (Shopify "Color" option
  // value, e.g. "Deep Ocean") rather than the canonical storefront bucket
  // (e.g. "Blue"). Single-variant products (fragrances) have no Color option,
  // so fall back to the raw customAttributes.colour metafield value.
  // Returns null for other shops (no change to their color handling).
  resolveProductColorValue(product) {
    if (this.shopName !== "bronze-snake-1.myshopify.com") return null;
    return product.shopifyColorOption || product.rawColorMeta || null;
  }

  // Parses the `custom.related_colourways` metafield (a JSON array of
  // `gid://shopify/Product/<id>` references, which includes the product
  // itself) into a deduped list of bare sibling ids with self removed.
  // Returns [] for missing/invalid values. Stores without the metafield
  // (non-Bronze-Snake) get [] and no colourway edges.
  parseRelatedColourways(value, selfId) {
    if (!value) return [];
    let arr;
    try { arr = JSON.parse(value); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const self = String(selfId);
    const seen = new Set();
    const out = [];
    for (const gid of arr) {
      const idStr = String(gid).replace("gid://shopify/Product/", "").trim();
      if (!idStr || idStr === self || seen.has(idStr)) continue;
      seen.add(idStr);
      out.push(idStr);
    }
    return out;
  }

  // Asks Gemini to bucket the product into one of the 33 canonical colors.
  // Imported lazily to keep the helper out of the providers' import graph
  // (it only runs for the small slice of BS products missing the metafield).
  async detectCanonicalColorForProduct(product) {
    const { detectCanonicalColor } = await import("../services/detect-canonical-color.js");
    const imageUrl = product.heroImage
      || (typeof product.images?.[0] === "string" ? product.images[0] : product.images?.[0]?.src)
      || product.image;
    const r = await detectCanonicalColor({ title: product.title, imageUrl });
    return r.color || null;
  }

  // ==================== PER-SHOP PRODUCT QUERY FILTER ====================

  // Returns the Shopify GraphQL `query` argument used when fetching products.
  // Default: only `status:active`. Per-shop overrides go here.
  getProductQueryFilter() {
    if (this.shopName === "bronze-snake-1.myshopify.com") {
      // Only products actually visible on the storefront.
      return "status:active AND published_status:published";
    }
    return "status:active";
  }

  // ==================== PER-SHOP DEMOGRAPHIC DETECTION ====================

  // Returns an array of demographics (["man"], ["woman"], or ["man","woman"])
  // when the shop has gendered structure, or null to fall back to the CLI
  // `--demographic` default.
  detectDemographic(product, rawTags) {
    if (this.shopName === "bronze-snake-1.myshopify.com") {
      return this.detectBronzeSnakeDemographic(product);
    }
    return null;
  }

  // Bronze Snake stores men's and women's products with collection handles
  // prefixed by `mens-` / `womens-` and a matching `product_type`. Color smart
  // collections (mens-ivory, womens-cream) and admin buckets (gift-cards, mens,
  // mens-1, *-back-in-stock, ...) are NOT real gender signals — they're filtered
  // out via the shared `isBronzeSnakeAdminHandle` helper.
  // Products explicitly in BOTH (e.g. unisex caps) get ["man", "woman"]. Products
  // with no signal at all return [] and are saved without any HAS_DEMOGRAPHIC edge.
  detectBronzeSnakeDemographic(p) {
    const handles = (p.collections || [])
      .map(c => (c.handle || "").toLowerCase())
      .map(h => BS_HANDLE_TYPO_FIX[h] || h)
      .filter(h => !isBronzeSnakeAdminHandle(h));
    const productType = (p.product_type || "").toLowerCase();

    const hasMens = handles.some(h => h.startsWith("mens-")) || productType.startsWith("men");
    const hasWomens = handles.some(h => h.startsWith("womens-")) || productType.startsWith("women");

    if (hasMens && hasWomens) return ["man", "woman"];
    if (hasMens) return ["man"];
    if (hasWomens) return ["woman"];
    return [];
  }

  // Bronze Snake category resolution. Same two signals as the demographic
  // detector: real `mens-*` / `womens-*` collection handles first (most specific
  // wins), then the product's `product_type` lowercased & dash-normalized.
  // Ignores admin/utility/color/numbered handles via `isBronzeSnakeAdminHandle`.
  // Returns null when neither signal yields anything — no category is set and
  // the product won't be linked to a canonical category. (No AI fallback.)
  determineBronzeSnakeCategory(product) {
    const handles = (product.collections || [])
      .map(c => (c.handle || "").toLowerCase())
      .map(h => BS_HANDLE_TYPO_FIX[h] || h);
    const gendered = handles
      .filter(h => (h.startsWith("mens-") || h.startsWith("womens-")) && !isBronzeSnakeAdminHandle(h));

    if (gendered.length > 0) {
      const specific = gendered.filter(h => !BS_GENERIC_HANDLES.has(h));
      const candidates = specific.length > 0 ? specific : gendered;
      candidates.sort((a, b) => {
        const segDiff = b.split("-").length - a.split("-").length;
        if (segDiff !== 0) return segDiff;
        const lenDiff = b.length - a.length;
        if (lenDiff !== 0) return lenDiff;
        return a.localeCompare(b);
      });
      const cat = candidates[0];
      console.log(`  [BronzeSnake] category from collection handle: "${cat}" (chosen from ${handles.length} collections)`);
      return cat;
    }

    let productType = (product.product_type || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (BS_HANDLE_TYPO_FIX[productType]) productType = BS_HANDLE_TYPO_FIX[productType];
    if (productType) {
      console.log(`  [BronzeSnake] category from product_type: "${productType}" (no gendered handles)`);
      return productType;
    }

    console.log(`  [BronzeSnake] no category signal (no gendered handle, no product_type) — returning null`);
    return null;
  }

  // ==================== SHOP-SPECIFIC FEATURES ====================

  // Override for shop-specific category handling
  determineCategory(product, productProperties, websiteCategories) {
    let category;
    const productTypeCategory = product.product_type ? product.product_type.toLowerCase() : "";
    console.log("\n\ncheck", productTypeCategory);

    // Special handling for Bronze Snake — pick the most specific
    // mens-*/womens-* collection handle (e.g. "womens-jackets-coats")
    if (this.shopName === "bronze-snake-1.myshopify.com") {
      return this.determineBronzeSnakeCategory(product);
    }

    // Special handling for DyFashion
    if (this.shopName.includes("dyfashion")) {
      console.log("\n\n========================================");
      console.log("[DYFASHION] Getting category from collections");
      console.log("[DYFASHION] Product ID:", product.id);
      console.log("[DYFASHION] Product Title:", product.title);
      console.log("[DYFASHION] Collections:", JSON.stringify(product.collections, null, 2));
      console.log("[DYFASHION] CategoriesDetails:", JSON.stringify(product.categoriesDetails, null, 2));

      if (product.collections && product.collections.length > 0) {
        category = product.collections[0].title;
        console.log("\n✅ [DYFASHION] CATEGORY FROM COLLECTIONS:", category);
      } else if (product.categoriesDetails && product.categoriesDetails.length > 0) {
        console.log("[DYFASHION] Using categoriesDetails for category");
        category = product.categoriesDetails[0].category_seo_name || product.categoriesDetails[0].category_name;
        product.collections = product.categoriesDetails.map(c => ({
          id: c.category_id,
          title: c.category_seo_name || c.category_name,
          name: c.category_name
        }));
        console.log("\n✅ [DYFASHION] CATEGORY FROM CATEGORIESDETAILS:", category);
      } else {
        console.log("\n❌ [DYFASHION] No collections or categoriesDetails found");
        category = productProperties.category?.toLowerCase() || "clothing";
      }
      console.log("\n🏷️  [DYFASHION] FINAL CATEGORY:", category);
      console.log("========================================\n");
      console.log("✓ Continuing execution...\n");
      return category;
    }

    // Default handling for other shops — use last (most specific) collection
    if (product.collections && product.collections.length > 0) {
      category = product.collections[product.collections.length - 1].title;
      console.log("found category from collections (last/most specific)");
    } else if (websiteCategories.map(c => c.toLowerCase()).includes(productTypeCategory)) {
      category = productTypeCategory;
      console.log("found category");
    } else {
      console.log("not found category");
      console.log("productProperties.categories", productProperties.category, product.collections);
      category = productProperties.category?.toLowerCase() || "clothing";
    }

    console.log("category match", `initial category: ${product.product_type}`, `final category: ${category}`);
    return category;
  }

  async fetchRaicuTranslations(products) {
    console.log(`  [Raicu] Fetching English for ${products.length} products...`);
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (!p.handle) continue;
      try {
        const enRes = await fetch(`https://amalin.com/en-intl/products/${p.handle}.json`);
        if (enRes.ok) {
          const enData = await enRes.json();
          const enP = enData.product;
          p.en_title = enP.title?.trim() || "";
          p.en_price = enP.variants?.[0]?.price || "";
          p.en_price_currency = enP.variants?.[0]?.price_currency || "EUR";
          p.en_url = `https://amalin.com/en-intl/products/${p.handle}`;
          p.en_product_type = enP.product_type || "";
          p.en_description = enP.body_html ? stripHtml(enP.body_html).result : "";
          p.en_json = JSON.stringify(enP);
          console.log(`    ✓ EN: ${p.title?.substring(0, 30)}`);
        }
        if (i < products.length - 1) await delay(200);
      } catch (e) {
        console.log(`    ✗ EN error: ${p.handle}`);
      }
    }
  }

  async classifyStyle(product) {
    // Bogas style classification
    if (this.shopName === "bogas-com-international.myshopify.com") {
      console.log("  [BOGAS] Getting style code...");
      try {
        const result = await this.getProductStyleBogas(product);
        console.log("getProductStyleBogasResult", result);
        return result;
      } catch (e) {
        console.log("  [BOGAS] Style error:", e.message);
        return null;
      }
    }

    // DyFashion style classification
    if (this.shopName === "dyfashion.avanticart.ro") {
      console.log("  [DYFASHION] Getting style code...");
      try {
        const result = await this.getProductStyleDyFashion(product);
        console.log("getProductStyleDyFashion result", result);
        return result;
      } catch (e) {
        console.log("  [DYFASHION] Style error:", e.message);
        return null;
      }
    }

    return null;
  }

  async getProductStyleBogas(product) {
    console.log("getProductStyleBogas", product);
    const filteredData = extractRelevantFields(product);
    console.log("filteredData", filteredData);

    const PERSONAS = ["ELEGANT_CHIC", "ADVENTURE_LUXE", "ROMANTIC_SOFT", "URBAN_MINIMAL", "POWER_POLISHED"];
    const BODY_SHAPES = ["triangle", "inverted_triangle", "rectangle", "hourglass", "oval"];
    const SEASONS = ["winter", "summer", "autumn", "spring"];

    const messages = [
      { role: "system", content: "You are a fashion style classifier. Given product info, return a JSON style code with keys: body, personality, chromatic." },
      {
        role: "user",
        content: `
Product data:
${JSON.stringify(filteredData, null, 2)}

/* ---------- FULL RULES (learned from bogas.ro) ---------- */
• ELEGANT_CHIC
  – Satin, lace, chiffon, velvet or crepe fabrics
  – Jewel-tone or neutral evening palette (emerald, navy, burgundy, ivory)
  – Midi & column dresses, mermaid hems, cape sleeves
  – Formal sets (blazer + midi skirt) for weddings, galas, graduation
  – Accessories: pearl clutches, stilettos, crystal belts
• ADVENTURE_LUXE
  – Technical ski suits, overalls, padded jackets, metallic snow pants
  – Beach & resort neoprene swim, triangle bikinis, linen cover-ups
  – Bright primaries or icy metallics; performance zips, waterproof seams
  – Cross-sell: goggles, fur-trim hoods, sun visors
• ROMANTIC_SOFT
  – Ruffle, wrap, tiered or balloon-sleeve silhouettes
  – Pastel / floral prints, ditsy patterns, broderie anglaise
  – Day dresses, chiffon skirts, soft-knit cardigans
  – Accessories: silk scarves, straw hats, dainty belts
• URBAN_MINIMAL   (absorbs SPORTY_STREET)
  – Ribbed bodycon dresses, tank midi, cropped racer tanks, hoodie sets
  – Monochrome (black, white, beige, camel) or bold-stripe logo tracksuits
  – Straight denim, biker shorts, athleisure with stretch
  – Clean copy tone; comfort & 24-h wear emphasised
• POWER_POLISHED   (absorbs GLAM_DIVA)
  – Tailored blazer dresses, shoulder-padded suits, cigarette trousers
  – Club-ready vinyl or sequin minis that project confidence
  – Jewel or stark monochrome palette; waist-cinching belts, plunge necks
  – Split by occasion in copy ("Boardroom" vs "After-dark")

/* BODY SHAPE NOTES */
triangle           – shoulders narrower than hips; add volume up top
inverted_triangle  – broad shoulders; draw eye downward
rectangle          – little waist definition; add curves / structure
hourglass          – balanced bust & hips; emphasise waist
oval               – fuller midsection; elongate torso

/* CHROMATIC SEASONS */
winter  – cool undertone + high contrast: black, white, jewel, icy brights
summer  – cool undertone + soft contrast: dusty pastels, powdery blues
autumn  – warm undertone + muted depth: camel, rust, olive, mustard
spring  – warm undertone + clear brights: coral, peach, aqua, light gold

/* NEUTRAL COLORS */
Neutral colors (black, white, grey, beige, navy, cream) can work across multiple seasons:
- Set "is_neutral" to true if the product's dominant color is neutral
- Set "neutral_whitelist" to an array of seasons where this neutral color works well; for non-neutral items, set neutral_whitelist to []
- Provide "color_vec" as a 3-element array [L, a, b] representing the LAB color space values for the dominant color

Example:
  - Pure white: is_neutral=true, neutral_whitelist=["winter","summer","spring","autumn"], color_vec=[100, 0, 0]
  - Warm beige: is_neutral=true, neutral_whitelist=["autumn","spring"], color_vec=[80, 5, 20]
  - Cool grey: is_neutral=true, neutral_whitelist=["winter","summer"], color_vec=[60, 0, -5]
  - Coral dress: is_neutral=false, neutral_whitelist=[], color_vec=[70, 40, 30]`
      }
    ];

    if (product.image) {
      console.log("product.image", product.image);
      try {
        const bytes = await fetch(product.image).then(r => r.arrayBuffer());
        messages.push({
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" } }]
        });
      } catch (e) {
        console.warn("Could not fetch image for Bogas");
      }
    }

    const jsonSchema = {
      name: "product_style_classification",
      strict: true,
      schema: {
        type: "object",
        properties: {
          body: { type: "array", items: { type: "string", enum: BODY_SHAPES } },
          personality: { type: "array", items: { type: "string", enum: PERSONAS } },
          chromatic: { type: "array", items: { type: "string", enum: SEASONS } },
          is_neutral: { type: "boolean" },
          neutral_whitelist: { type: "array", items: { type: "string", enum: SEASONS } },
          color_vec: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }
        },
        required: ["body", "personality", "chromatic", "is_neutral", "neutral_whitelist", "color_vec"],
        additionalProperties: false
      }
    };

    const completion = await openaiService.client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1000,
      response_format: { type: "json_schema", json_schema: jsonSchema },
      messages
    });

    return JSON.parse(completion.choices[0].message.content);
  }

  async getProductStyleDyFashion(product) {
    console.log("getProductStyleDyFashion", product);
    const filteredData = extractRelevantFields(product);
    console.log("filteredData", filteredData);

    const PERSONAS = ["classic", "romantic", "creative"];
    const BODY_SHAPES = ["triangle", "inverted_triangle", "rectangle", "hourglass", "oval"];
    const SEASONS = ["winter", "spring", "summer", "autumn"];

    const messages = [
      { role: "system", content: "You are a fashion style classifier. Given product info, return a JSON style code with keys: body, personality, chromatic." },
      {
        role: "user",
        content: `
Product data:
${JSON.stringify(filteredData, null, 2)}

Analyze the product for recommended silhouette, personality, and color palette.

## Body Shapes
- "triangle": shoulders narrower than hips
- "inverted_triangle": broad shoulders
- "rectangle": little waist definition
- "hourglass": balanced bust & hips
- "oval": fuller midsection

## Personality Types
- "classic": timeless, elegant, structured pieces
- "romantic": soft, feminine, flowing silhouettes
- "creative": bold, artistic, unique designs

## Chromatic Seasons
- "winter": cool undertone, high contrast (black, white, jewel tones)
- "summer": cool undertone, soft contrast (dusty pastels, powdery blues)
- "autumn": warm undertone, muted depth (camel, rust, olive, mustard)
- "spring": warm undertone, clear brights (coral, peach, aqua)

Make sure the response is valid JSON, with no additional text or formatting beyond the JSON object itself.
Include at least one value for "body", "personality", and "chromatic" in every response. 

##Neutral Colors Handling

Neutral colors (black, white, grey, beige, navy, cream, tan) can work across multiple seasons:
- Set "is_neutral" to true if the product's dominant color is neutral (not seasonal colors like coral, emerald, mustard, etc.)
- Set "neutral_whitelist" to an array of seasons where this neutral color works well
- Provide "color_vec" as a 3-element array [L, a, b] representing the LAB color space values for the dominant color
  (L = lightness 0-100, a = green-red axis -128 to 127, b = blue-yellow axis -128 to 127)

Example responses:
  - Pure white product: is_neutral=true, neutral_whitelist=["winter","summer","spring","autumn"], color_vec=[100, 0, 0]
  - Warm beige product: is_neutral=true, neutral_whitelist=["autumn","spring"], color_vec=[80, 5, 20]
  - Cool grey product: is_neutral=true, neutral_whitelist=["winter","summer"], color_vec=[60, 0, -5]
  - Black product: is_neutral=true, neutral_whitelist=["winter","autumn"], color_vec=[0, 0, 0]
  - Navy product: is_neutral=true, neutral_whitelist=["winter","summer","autumn"], color_vec=[25, 10, -30]
  - Coral dress: is_neutral=false (seasonal color - spring), no neutral_whitelist, color_vec=[70, 40, 30]`
      }
    ];

    if (product.image) {
      try {
        const bytes = await fetch(product.image).then(r => r.arrayBuffer());
        messages.push({
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" } }]
        });
      } catch (e) {
        console.warn("Could not fetch image for DyFashion");
      }
    }

    const jsonSchema = {
      name: "product_style_classification_dyfashion",
      strict: true,
      schema: {
        type: "object",
        properties: {
          body: { type: "array", items: { type: "string", enum: BODY_SHAPES } },
          personality: { type: "array", items: { type: "string", enum: PERSONAS } },
          chromatic: { type: "array", items: { type: "string", enum: SEASONS } },
          is_neutral: { type: "boolean" },
          neutral_whitelist: { type: "array", items: { type: "string", enum: SEASONS } },
          color_vec: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }
        },
        required: ["body", "personality", "chromatic", "is_neutral", "neutral_whitelist", "color_vec"],
        additionalProperties: false
      }
    };

    const completion = await openaiService.client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1000,
      response_format: { type: "json_schema", json_schema: jsonSchema },
      messages
    });

    return JSON.parse(completion.choices[0].message.content);
  }

  logFinalStats() {
    const pct = (n) => this.stats.totalFetched > 0 ? ((n / this.stats.totalFetched) * 100).toFixed(1) : '0.0';
    console.log("\n  ════════════════════════════════════════════════════════════");
    console.log("  [Shopify] SYNC STATS:");
    console.log(`    Total fetched from API:    ${this.stats.totalFetched}`);
    console.log(`    With description:          ${this.stats.withDescription} (${pct(this.stats.withDescription)}%)`);
    console.log(`    Without description:       ${this.stats.withoutDescription} (${pct(this.stats.withoutDescription)}%)`);
    console.log(`    With images:               ${this.stats.withImages} (${pct(this.stats.withImages)}%)`);
    console.log(`    Without images:             ${this.stats.withoutImages} (${pct(this.stats.withoutImages)}%)`);
    console.log(`    Zero inventory:            ${this.stats.zeroInventory} (${pct(this.stats.zeroInventory)}%)`);
    console.log(`    Total variants:            ${this.stats.totalVariants}`);
    console.log("  ════════════════════════════════════════════════════════════\n");
  }

  async sync() {
    console.log(`\n=== Starting ${this.providerType} Sync for ${this.shopName} ===`);
    console.log(`  [Shopify] Fetching active products via GraphQL Admin API`);
    console.log(`  [Shopify] Default demographic: ${this.demographic}\n`);

    await super.sync();

    this.logFinalStats();
  }

  // Override to handle Bogas HTML->Markdown and DyFashion S3 uploads
  async processProducts(products, defaultCategories, shopData) {
    // First do standard processing
    const processedProducts = await super.processProducts(products, defaultCategories, shopData);

    // Then do shop-specific post-processing
    for (const product of processedProducts) {
      // Bogas: Convert HTML to Markdown
      if (this.shopName === "bogas-com-international.myshopify.com") {
        console.log("  [BOGAS] Converting HTML to Markdown");
        product.body_html = convertHtmlToMarkdown(product.descriptionHtml || product.body_html);
      }

      // DyFashion: Upload images to S3
      if (this.shopName === "dyfashion.avanticart.ro" && product.images && product.images.length > 0) {
        console.log(`  [DYFASHION] Uploading ${product.images.length} images to S3...`);
        const imageUrls = product.images.map(img => typeof img === 'string' ? img : img.src);
        const uploadedUrls = await s3Service.uploadMultipleImages(imageUrls);
        product.images = uploadedUrls.map(url => ({ src: url }));
        if (uploadedUrls.length > 0) {
          product.image = uploadedUrls[0];
        }
      }
    }

    return processedProducts;
  }
}

export default ShopifyProvider;
