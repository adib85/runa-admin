/**
 * Neo4j Database Service
 * Handles all Neo4j operations for product sync
 */

import neo4j from "neo4j-driver";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "./config.js";

export class Neo4jService {
  constructor() {
    this.uri = NEO4J_URI;
    this.user = NEO4J_USER;
    this.password = NEO4J_PASSWORD;
  }

  getDriver() {
    return neo4j.driver(this.uri, neo4j.auth.basic(this.user, this.password));
  }

  async createApplicationAndStore(storeData, appData) {
    const { id: storeId, storeName } = storeData;
    const { id: appId, appName } = appData;
    const driver = this.getDriver();

    // Ensure the composite index backing store-namespaced categories (idempotent; harmless
    // for stores that don't set Category.storeId). Schema ops must run outside a data tx.
    const schemaSession = driver.session();
    try {
      await schemaSession.run(
        `CREATE INDEX bringo_category_store_slug IF NOT EXISTS FOR (c:Category) ON (c.storeId, c.slug)`
      );
      // :Location node — multi-merchant marketplaces (Quicklly) link Store -> Location
      // via DELIVERS_TO. Harmless for single-store providers (Bringo/Shopify/VTEX): no
      // :Location nodes are written unless `createOrUpdateLocations` is called.
      await schemaSession.run(
        `CREATE CONSTRAINT location_slug_unique IF NOT EXISTS FOR (l:Location) REQUIRE l.slug IS UNIQUE`
      );
      // Per-merchant denormalized fields on Product (additive — null for providers
      // that don't populate them). Indexed because chat queries filter on them.
      await schemaSession.run(
        `CREATE INDEX product_merchant_slug IF NOT EXISTS FOR (p:Product) ON (p.merchant_slug)`
      );
      await schemaSession.run(
        `CREATE INDEX product_subcategory_slug IF NOT EXISTS FOR (p:Product) ON (p.subcategory_slug)`
      );
    } catch (e) {
      console.log("  [index] schema setup:", e.message);
    } finally {
      await schemaSession.close();
    }

    const session = driver.session();
    const tx = session.beginTransaction();

    try {
      await tx.run(
        `MERGE (app:Application {id: $appId}) ON CREATE SET app.name = $appName ON MATCH SET app.name = $appName`,
        { appId, appName }
      );
      await tx.run(
        `MERGE (store:Store {id: $storeId}) ON CREATE SET store.name = $storeName ON MATCH SET store.name = $storeName
         WITH store MATCH (app:Application {id: $appId}) MERGE (app)-[:HAS_STORE]->(store)`,
        { storeId, storeName, appId }
      );
      await tx.commit();
      console.log("store created", storeData, appData);
    } catch (e) {
      await tx.rollback();
      console.log(e);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async createOrUpdateCategories(categories) {
    const driver = this.getDriver();
    const session = driver.session();
    const tx = session.beginTransaction();
    try {
      await Promise.all(
        categories.map(c =>
          tx.run(`MERGE (c:Category {name: toLower($title)}) ON CREATE SET c.name = toLower($title)`, { title: c.title })
        )
      );
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      console.error(e);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Location nodes (marketplace providers only — e.g. Quicklly).
  // Single-store providers never call these methods; their data is unaffected.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * MERGE a :Location node per slug. `locations` is an array of either bare
   * slug strings or { slug, city?, state?, lat?, lng? } objects.
   */
  async createOrUpdateLocations(locations) {
    if (!locations || locations.length === 0) return;
    const normalized = locations.map(l =>
      typeof l === "string"
        ? { slug: l, city: null, state: null, lat: null, lng: null }
        : { slug: l.slug, city: l.city ?? null, state: l.state ?? null, lat: l.lat ?? null, lng: l.lng ?? null }
    );
    const driver = this.getDriver();
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $locations AS loc
         MERGE (l:Location {slug: loc.slug})
         ON CREATE SET l.city = loc.city, l.state = loc.state, l.lat = loc.lat, l.lng = loc.lng
         ON MATCH SET l.city = coalesce(loc.city, l.city), l.state = coalesce(loc.state, l.state),
                       l.lat = coalesce(loc.lat, l.lat), l.lng = coalesce(loc.lng, l.lng)`,
        { locations: normalized }
      );
      console.log(`  [neo4j] createOrUpdateLocations: ${normalized.length} location(s) merged`);
    } catch (e) {
      console.error("  [neo4j] createOrUpdateLocations failed:", e.message);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  /**
   * Link a Store to its delivery locations. `locationSlugs` is an array of slugs
   * the store delivers to. Edges are MERGEd so re-runs are idempotent. Stale edges
   * (locations the store no longer serves) are NOT deleted here — call
   * `unlinkStoreDeliveryStaleness(storeId, syncRunStartedAt)` if you need that.
   */
  async linkStoreDelivery(storeId, locationSlugs) {
    if (!storeId || !locationSlugs || locationSlugs.length === 0) return;
    const nowIso = new Date().toISOString();
    const driver = this.getDriver();
    const session = driver.session();
    try {
      await session.run(
        `MATCH (s:Store {id: $storeId})
         UNWIND $slugs AS slug
         MATCH (l:Location {slug: slug})
         MERGE (s)-[r:DELIVERS_TO]->(l)
         ON CREATE SET r.lastSeenAt = $nowIso
         ON MATCH SET r.lastSeenAt = $nowIso`,
        { storeId, slugs: locationSlugs, nowIso }
      );
      console.log(`  [neo4j] linkStoreDelivery: ${storeId} -> ${locationSlugs.length} location(s)`);
    } catch (e) {
      console.error("  [neo4j] linkStoreDelivery failed:", e.message);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async getExistingProductIds(storeId, productIds) {
    const driver = this.getDriver();
    const session = driver.session();
    try {
      const idList = productIds.map(id => `"${id}"`).join(', ');
      const result = await session.run(
        `MATCH (p:Product) WHERE p.storeId = "${storeId}" AND p.id IN [${idList}] AND (p.need_update IS NULL OR p.need_update <> true) RETURN p.id as existingId`
      );
      return new Set(result.records.map(r => String(r.get('existingId'))));
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async saveProducts(productsData, storeData, appData, demographicsData) {
    console.log("saving products", productsData.length);

    // Safety net: Product nodes are MERGEd GLOBALLY by id (not scoped by store), so an id
    // that already belongs to a different store would be OVERWRITTEN. Warn loudly (and, under
    // SYNC_STRICT_STORE_ISOLATION=true, skip those products). Providers should namespace ids
    // per store up front — see storePrefixedId() in ../utils/index.js.
    productsData = await this._guardCrossStoreCollisions(productsData, storeData.id);
    if (productsData.length === 0) { console.log("  Nothing to save after id-collision guard"); return; }

    // Batch products into chunks of 25 to avoid large transactions
    const BATCH_SIZE = 25;
    const batches = [];
    for (let i = 0; i < productsData.length; i += BATCH_SIZE) {
      batches.push(productsData.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`  Saving in ${batches.length} batch(es) of max ${BATCH_SIZE} products`);
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      await this._saveBatch(batch, storeData, demographicsData, batchIndex + 1, batches.length);
    }
    
    console.log("All batches saved successfully");
  }

  /**
   * Detect incoming product ids that already belong to a DIFFERENT store. Because the
   * Product MERGE key is global (`{id}`), writing such a product OVERWRITES the other
   * store's node. Default: log a prominent warning and proceed. With
   * SYNC_STRICT_STORE_ISOLATION=true: drop the colliding products so nothing is overwritten.
   */
  async _guardCrossStoreCollisions(productsData, storeId) {
    if (!productsData?.length) return productsData;
    const ids = productsData.map(p => String(p.id));
    const driver = this.getDriver();
    const session = driver.session();
    let collisions = [];
    try {
      const res = await session.run(
        `MATCH (p:Product)
         WHERE p.id IN $ids AND p.storeId IS NOT NULL AND p.storeId <> $storeId
         RETURN p.id AS id, p.storeId AS storeId`,
        { ids, storeId }
      );
      collisions = res.records.map(r => ({ id: String(r.get("id")), storeId: r.get("storeId") }));
    } catch (e) {
      console.log("  [id-guard] collision check failed (continuing):", e.message);
      return productsData;
    } finally {
      await session.close();
      await driver.close();
    }
    if (!collisions.length) return productsData;

    const strict = process.env.SYNC_STRICT_STORE_ISOLATION === "true";
    console.warn("\n  ╔════════════════════════════════════════════════════════════════════╗");
    console.warn(`  ║  ⚠  PRODUCT ID COLLISION: ${collisions.length} incoming id(s) belong to OTHER stores`);
    console.warn(`  ║  Writing store: ${storeId}`);
    collisions.slice(0, 10).forEach(c => console.warn(`  ║    id ${c.id}  is already owned by  ${c.storeId}`));
    if (collisions.length > 10) console.warn(`  ║    …and ${collisions.length - 10} more`);
    console.warn("  ║  These MERGE globally by id and would OVERWRITE the other store's node.");
    console.warn("  ║  Fix: namespace the provider's ids per store — storePrefixedId(storeId, rawId).");
    console.warn(`  ║  ${strict ? "STRICT mode → skipping these products." : "Set SYNC_STRICT_STORE_ISOLATION=true to skip them automatically."}`);
    console.warn("  ╚════════════════════════════════════════════════════════════════════╝\n");

    if (strict) {
      const bad = new Set(collisions.map(c => c.id));
      return productsData.filter(p => !bad.has(String(p.id)));
    }
    return productsData;
  }

  async _saveBatch(productsData, storeData, demographicsData, batchNum, totalBatches) {
    const driver = this.getDriver();
    const session = driver.session();
    const tx = session.beginTransaction();

    try {
      const newProducts = productsData.map(p => this._prepareProductForSave(p, storeData, demographicsData));
      const nowIso = new Date().toISOString();

      const productProps = `{
           id: product.productId, need_update: null, title: product.title, titleEmbedding: product.titleEmbedding,
           description: product.description, descriptionSource: product.descriptionSource, content: product.content, product: product.product,
           seoTitle: product.seoTitle, seoMetaDescription: product.seoMetaDescription, seoSource: product.seoSource,
           characteristics: product.characteristics, styleCode: product.styleCode, styleData: product.styleData,
           styleBody: product.styleBody, stylePersonality: product.stylePersonality, styleChromatic: product.styleChromatic,
           is_neutral: product.is_neutral, neutral_whitelist: product.neutral_whitelist, color_vec: product.color_vec,
           image: product.image, images: product.images, vendor: product.vendor, currency: product.currency, price: product.price,
           heroImage: product.heroImage, heroImageIndex: product.heroImageIndex, heroImageSource: product.heroImageSource, heroImageDecidedAt: product.heroImageDecidedAt,
           category: product.category, handle: product.handle, status: product.status, storeId: product.storeId,
           contentEmbedding: product.contentEmbedding, productEmbedding: product.productEmbedding,
           characteristicsEmbedding: product.characteristicsEmbedding, categoryEmbedding: product.categoryEmbedding,
           styleCodeEmbedding: product.styleCodeEmbedding, searchAttributesText: product.searchAttributesText,
           searchAttributesEmbedding: product.searchAttributesEmbedding, updated_at: $nowIso,
           color: COALESCE(product.color, product.detectedColor, CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorValue ELSE null END),
           colorEmbedding: COALESCE(product.colorEmbedding, CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorEmbedding ELSE null END),
           canonicalColor: product.canonicalColor,
           sizes: product.sizes,
           sizeTokens: product.sizeTokens,
           availableSizes: product.availableSizes,
           availableSizeTokens: product.availableSizeTokens,
           styleFilters: product.styleFilters,
           sizeChartJson: product.sizeChartJson,
           published_date: COALESCE(product.published_date, p.published_date),
           price_old: product.price_old,
           onSale: product.onSale,
           inStock: product.inStock,
           materialDominant: COALESCE(product.materialDominant, p.materialDominant),
           materials: COALESCE(product.materials, p.materials),
           materialComposition: COALESCE(product.materialComposition, p.materialComposition),
           en_title: product.en_title, en_price: product.en_price, en_price_currency: product.en_price_currency,
           en_url: product.en_url, en_product_type: product.en_product_type, en_description: product.en_description, en_json: product.en_json,
           sku: product.sku,
           related_colourways: product.relatedColourways,
           lastSeenAt: COALESCE(product.lastSeenAt, p.lastSeenAt),
           // Optional marketplace / grocery-provider denormalized fields. Null for
           // providers that don't emit them (Shopify/VTEX/Bringo) — additive, no breakage.
           merchant_slug: product.merchant_slug,
           merchant_storeid: product.merchant_storeid,
           merchant_name: product.merchant_name,
           nationwide: product.nationwide,
           subcategory_slug: product.subcategory_slug,
           subcategory_name: product.subcategory_name,
           department_slug: product.department_slug,
           department_name: product.department_name,
           brand: product.brand,
           pack_size: product.pack_size,
           product_type: product.product_type,
           aliases_text: product.aliases_text,
           title_normalized: product.title_normalized
         }`;

      // Query 1: Create/update products + Store relationship + Demographics
      // These are isolated from optional UNWINDs so they always execute
      await tx.run(
        `UNWIND $newProducts AS product
         MERGE (p:Product {id: product.productId})
         ON CREATE SET p += ${productProps}
         ON MATCH SET p += ${productProps}
         WITH p, product
         MATCH (store:Store {id: product.storeId})
         MERGE (store)-[:HAS_PRODUCT]->(p)
         WITH p, product
         FOREACH (demographic IN product.demographics |
           MERGE (d:Demographic {name: demographic})
           MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)
         )`,
        { newProducts, nowIso }
      );

      // Query 2: Variants (isolated — empty variants won't break other relationships)
      await tx.run(
        `UNWIND $newProducts AS product
         MATCH (p:Product {id: product.productId})
         WITH p, product
         UNWIND product.variants AS variant
         MERGE (v:Variant {id: variant.id})
         ON CREATE SET v += { id: variant.id, title: variant.title, price: variant.price, price_old: variant.compare_at_price,
           size: variant.sizeValue, color: variant.colorValue, sizeEmbedding: variant.sizeEmbedding, colorEmbedding: variant.colorEmbedding, inventoryQuantity: variant.inventory_quantity }
         ON MATCH SET v += { id: variant.id, title: variant.title, price: variant.price, price_old: variant.compare_at_price,
           size: variant.sizeValue, color: variant.colorValue, sizeEmbedding: variant.sizeEmbedding, colorEmbedding: variant.colorEmbedding, inventoryQuantity: variant.inventory_quantity }
         MERGE (p)-[:HAS_VARIANT]->(v)`,
        { newProducts }
      );

      // Query 3a: Categories from collections — DEFAULT global flat Category (fashion etc.).
      // Filtered to non-hierarchy products so it leaves the store-namespaced path alone.
      await tx.run(
        `UNWIND $newProducts AS product
         WITH product WHERE coalesce(product.categoryHierarchy, false) = false
         MATCH (p:Product {id: product.productId})
         WITH p, product
         UNWIND product.collections AS collection
         MERGE (c:Category {name: toLower(collection.title)})
         MERGE (p)-[:HAS_CATEGORY]->(c)`,
        { newProducts }
      );

      // Query 3b: store-namespaced Category + CHILD_OF hierarchy (e.g. Bringo grocery).
      // Categories are keyed by (storeId, slug) so a grocery taxonomy can't collide with
      // other stores' categories; the ordered chain (collections is top→leaf) becomes a
      // CHILD_OF parent chain, enabling roll-ups (all products under a top group, etc.).
      const hasHierarchy = newProducts.some(p => p.categoryHierarchy === true);
      if (hasHierarchy) {
        await tx.run(
          `UNWIND $newProducts AS product
           WITH product WHERE product.categoryHierarchy = true
           MATCH (p:Product {id: product.productId})
           WITH p, product
           UNWIND product.collections AS collection
           MERGE (c:Category {storeId: product.storeId, slug: collection.handle})
             ON CREATE SET c.name = collection.title
             ON MATCH SET c.name = collection.title
           MERGE (p)-[:HAS_CATEGORY]->(c)`,
          { newProducts }
        );
        await tx.run(
          `UNWIND $newProducts AS product
           WITH product WHERE product.categoryHierarchy = true AND size(product.collections) > 1
           UNWIND range(0, size(product.collections) - 2) AS i
           WITH product.storeId AS storeId, product.collections[i] AS parent, product.collections[i + 1] AS child
           MERGE (pc:Category {storeId: storeId, slug: parent.handle}) ON CREATE SET pc.name = parent.title ON MATCH SET pc.name = parent.title
           MERGE (cc:Category {storeId: storeId, slug: child.handle}) ON CREATE SET cc.name = child.title ON MATCH SET cc.name = child.title
           MERGE (cc)-[:CHILD_OF]->(pc)`,
          { newProducts }
        );

        // Query 3d: the LEAF category — the product's authoritative breadcrumb category (the
        // last collection). Persist it straight on the Product (leaf_category /
        // leaf_category_slug), flag the Category node as a leaf (is_leaf=true), and add a
        // first-class (Product)-[:IN_LEAF_CATEGORY]->(Category) mapping for easy querying.
        await tx.run(
          `UNWIND $newProducts AS product
           WITH product WHERE product.categoryHierarchy = true AND size(product.collections) > 0
           MATCH (p:Product {id: product.productId})
           OPTIONAL MATCH (p)-[old:IN_LEAF_CATEGORY]->()
           DELETE old
           WITH DISTINCT p, product
           WITH p, product, product.collections[size(product.collections) - 1] AS leaf
           SET p.leaf_category = leaf.title, p.leaf_category_slug = leaf.handle
           MERGE (lc:Category {storeId: product.storeId, slug: leaf.handle})
             ON CREATE SET lc.name = leaf.title, lc.is_leaf = true
             ON MATCH SET lc.name = leaf.title, lc.is_leaf = true
           MERGE (p)-[:IN_LEAF_CATEGORY]->(lc)`,
          { newProducts }
        );
      }

      // Query 4: Categories from tags (only for providers where tags are meaningful categories)
      const hasTagCategories = newProducts.some(p => p.tagsAsCategories && p.tags);
      if (hasTagCategories) {
        await tx.run(
          `UNWIND $newProducts AS product
           WITH product WHERE product.tagsAsCategories = true AND product.tags <> ""
           MATCH (p:Product {id: product.productId})
           WITH p, product
           UNWIND split(product.tags, ",") AS tag
           WITH p, trim(tag) AS tag WHERE tag <> ""
           MERGE (c:Category {name: toLower(tag)})
           MERGE (p)-[:HAS_CATEGORY]->(c)`,
          { newProducts }
        );
      }

      // Query 5: Related colourways (same style, different colors). Self-healing:
      // first clear this batch's existing edges, then re-link to colourway siblings
      // that exist as nodes. Edges are written BOTH directions so traversal is
      // order-independent across batches (a sibling may live in a later batch and
      // not exist yet when this one runs; whichever batch is processed last for a
      // given pair recreates both directions). Siblings not in the graph are skipped.
      await tx.run(
        `UNWIND $newProducts AS product
         MATCH (a:Product {id: product.productId})-[r:RELATED_COLOURWAY]-()
         DELETE r`,
        { newProducts }
      );
      await tx.run(
        `UNWIND $newProducts AS product
         MATCH (a:Product {id: product.productId})
         UNWIND product.relatedColourways AS sibId
         MATCH (b:Product {id: sibId})
         MERGE (a)-[:RELATED_COLOURWAY]->(b)
         MERGE (b)-[:RELATED_COLOURWAY]->(a)`,
        { newProducts }
      );

      await tx.commit();
      console.log(`  ✓ Batch ${batchNum}/${totalBatches}: ${productsData.length} products saved`);
    } catch (error) {
      console.log(`  ✗ Batch ${batchNum}/${totalBatches} failed, rolling back...`);
      console.log("products not saved ", productsData.length);
      await tx.rollback();
      console.error("Transaction rolled back due to error:", error);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  _prepareProductForSave(p, storeData, demographicsData) {
    let images = p.images ? p.images.map(img => typeof img === 'string' ? img : img.src) : [];
    let styleData = p.styleData;
    let styleBody = null, stylePersonality = null, styleChromatic = null;
    let is_neutral = null, neutral_whitelist = null, color_vec = null;

    if (styleData) {
      const obj = typeof styleData === 'string' ? JSON.parse(styleData) : styleData;
      if (obj) {
        styleBody = obj.body;
        stylePersonality = obj.personality;
        styleChromatic = obj.chromatic;
        is_neutral = obj.is_neutral;
        neutral_whitelist = obj.neutral_whitelist;
        color_vec = obj.color_vec;
      }
    }

    let description = p.body_html || "";
    let descriptionSource = p.descriptionSource || "original";

    return {
      productId: p.id.toString(),
      storeId: storeData.id,
      title: p.title,
      titleEmbedding: p.titleEmbedding || null,
      description,
      descriptionSource,
      seoTitle: p.seoTitle || null,
      seoMetaDescription: p.seoMetaDescription || null,
      seoSource: p.seoSource || null,
      vendor: p.vendor,
      category: p.category,
      handle: p.handle,
      status: p.status,
      variants: p.variants || [],
      options: p.options,
      properties: p.properties,
      content: p.content,
      product: p.product,
      characteristics: p.characteristics,
      styleCode: p.styleCode || "none",
      styleData: typeof styleData === 'object' ? JSON.stringify(styleData) : styleData,
      contentEmbedding: p.contentEmbedding || null,
      productEmbedding: p.productEmbedding || null,
      characteristicsEmbedding: p.characteristicsEmbedding || null,
      categoryEmbedding: p.categoryEmbedding || null,
      styleCodeEmbedding: p.styleCodeEmbedding || null,
      image: p.image,
      images,
      heroImage: p.heroImage || null,
      heroImageIndex: typeof p.heroImageIndex === "number" ? p.heroImageIndex : null,
      heroImageSource: p.heroImageSource || null,
      heroImageDecidedAt: p.heroImageDecidedAt || null,
      // Use product-specific detected demographics if available, otherwise use default
      demographics: p.detectedDemographics || demographicsData,
      currency: p.currency,
      price: typeof p.price === "number" && Number.isFinite(p.price) ? p.price : null,
      collections: p.collections || [],
      // When true, categories are store-namespaced ({storeId, slug}) and the ordered
      // collections (top→leaf) are linked with CHILD_OF edges. Default false = legacy
      // global flat Category (fashion stores keep their existing behavior).
      categoryHierarchy: p.categoryHierarchy === true,
      tags: p.tags || "",
      tagsAsCategories: p.tagsAsCategories !== undefined ? p.tagsAsCategories : true,
      styleBody,
      stylePersonality,
      styleChromatic,
      is_neutral,
      neutral_whitelist,
      color_vec,
      searchAttributesText: p.searchAttributesText || "",
      searchAttributesEmbedding: p.searchAttributesEmbedding || null,
      sizes: p.sizes || [],
      sizeTokens: p.sizeTokens || [],
      availableSizes: p.availableSizes || [],
      availableSizeTokens: p.availableSizeTokens || [],
      styleFilters: p.styleFilters || [],
      sizeChartJson: p.sizeChartJson || null,
      published_date: p.published_at || null,
      price_old: typeof p.price_old === "number" && Number.isFinite(p.price_old) ? p.price_old : null,
      onSale: p.onSale === true,
      // Fresh in-stock flag (default true when the provider doesn't compute one).
      inStock: p.inStock !== undefined ? (p.inStock === true) : true,
      materialDominant: p.materialDominant || null,
      materials: p.materials?.length ? p.materials : null,
      materialComposition: p.materialComposition || null,
      detectedColor: p.detectedColor || null,
      color: p.color || null,
      colorEmbedding: p.colorEmbedding || null,
      canonicalColor: p.canonicalColor || null,
      // ─── Marketplace / grocery-provider denormalized fields ─────────────────
      // All optional. Null for providers that don't emit them (Shopify/VTEX/Bringo
      // unaffected — undefined → null). Used by chat search for fast facet filtering.
      merchant_slug: p.merchant_slug ?? null,
      merchant_storeid: p.merchant_storeid != null ? String(p.merchant_storeid) : null,
      merchant_name: p.merchant_name ?? null,
      // Ships-everywhere flag. When true, chat treats the product as a candidate for
      // ALL user locations (not gated by the store's DELIVERS_TO footprint). Default
      // false → location-gated as usual. Only set by marketplace providers.
      nationwide: p.nationwide === true,
      subcategory_slug: p.subcategory_slug ?? null,
      subcategory_name: p.subcategory_name ?? null,
      department_slug: p.department_slug ?? null,
      department_name: p.department_name ?? null,
      brand: p.brand ?? null,
      pack_size: p.pack_size ?? null,
      product_type: p.product_type ?? null,
      aliases_text: p.aliases_text ?? null,
      title_normalized: p.title_normalized ?? null,
      relatedColourways: p.relatedColourways || [],
      en_title: p.en_title || null,
      en_price: p.en_price || null,
      en_price_currency: p.en_price_currency || null,
      en_url: p.en_url || null,
      en_product_type: p.en_product_type || null,
      en_description: p.en_description || null,
      en_json: p.en_json || null,
      sku: p.sku || p.vtex?.productReference || null,
      lastSeenAt: p.lastSeenAt || null
    };
  }

  async stampLastSeenAt(storeId, productIds, timestamp) {
    const driver = this.getDriver();
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $productIds AS productId
         MATCH (p:Product {id: productId})
         WHERE p.storeId = $storeId
         SET p.lastSeenAt = $timestamp`,
        { productIds: productIds.map(id => String(id)), storeId, timestamp }
      );
    } finally {
      await session.close();
      await driver.close();
    }
  }

  /**
   * Stamp presence (lastSeenAt) AND a fresh in-stock flag on every product seen during a
   * sync — existing and new alike — in one cheap pass, without reprocessing. `items` is
   * [{ id, inStock }]. p.inStock is refreshed every run from the provider's real inventory
   * so it never goes stale under incremental (--missing) syncs. Consumed by the chat /
   * Complete-the-Look / Similar candidate filters via coalesce(p.inStock, true).
   * Newly-created products get p.inStock from the save path (_saveBatch) instead, since
   * they don't exist yet when this stamping pass runs.
   */
  async stampSeen(storeId, items, timestamp) {
    if (!items || items.length === 0) return;
    const driver = this.getDriver();
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $items AS item
         MATCH (p:Product {id: item.id})
         WHERE p.storeId = $storeId
         SET p.lastSeenAt = $timestamp, p.inStock = item.inStock,
             p.availableSizes = item.availableSizes, p.availableSizeTokens = item.availableSizeTokens,
             p.price = COALESCE(item.price, p.price)`,
        { items: items.map(i => ({
            id: String(i.id),
            inStock: i.inStock === true,
            availableSizes: i.availableSizes || [],
            availableSizeTokens: i.availableSizeTokens || [],
            price: (typeof i.price === "number" && Number.isFinite(i.price)) ? i.price : null,
          })), storeId, timestamp }
      );
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async deleteStaleProducts(storeId, syncRunStartedAt) {
    const driver = this.getDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
         WHERE p.lastSeenAt IS NOT NULL AND p.lastSeenAt < $syncRunStartedAt
         RETURN count(p) AS staleCount, collect(p.title)[0..20] AS sampleTitles`,
        { storeId, syncRunStartedAt }
      );

      const record = result.records[0];
      const staleCount = record ? (record.get('staleCount').toNumber ? record.get('staleCount').toNumber() : Number(record.get('staleCount'))) : 0;
      const sampleTitles = record ? record.get('sampleTitles') || [] : [];

      if (staleCount > 0) {
        await session.run(
          `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
           WHERE p.lastSeenAt IS NOT NULL AND p.lastSeenAt < $syncRunStartedAt
           DETACH DELETE p`,
          { storeId, syncRunStartedAt }
        );
      }

      return { staleCount, sampleTitles };
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async cleanupOrphanedVariants() {
    const driver = this.getDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (v:Variant) WHERE NOT (v)<-[:HAS_VARIANT]-(:Product)
         RETURN count(v) AS cnt`
      );
      const orphanCount = result.records[0]?.get('cnt');
      const count = orphanCount?.toNumber ? orphanCount.toNumber() : Number(orphanCount || 0);

      if (count > 0) {
        await session.run(
          `MATCH (v:Variant) WHERE NOT (v)<-[:HAS_VARIANT]-(:Product)
           DETACH DELETE v`
        );
      }
      return count;
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async fetchCategories(storeId) {
    const driver = this.getDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)-[:HAS_CATEGORY]->(c:Category) RETURN DISTINCT c.name AS name`,
        { storeId }
      );
      return result.records.map(r => r.get("name"));
    } catch (e) {
      console.error("Failed to fetch categories:", e);
      return [];
    } finally {
      await session.close();
      await driver.close();
    }
  }
}

export default new Neo4jService();
