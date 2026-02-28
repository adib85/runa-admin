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

  async _saveBatch(productsData, storeData, demographicsData, batchNum, totalBatches) {
    const driver = this.getDriver();
    const session = driver.session();
    const tx = session.beginTransaction();

    try {
      const newProducts = productsData.map(p => this._prepareProductForSave(p, storeData, demographicsData));
      const nowIso = new Date().toISOString();

      await tx.run(
        `UNWIND $newProducts AS product
         MERGE (p:Product {id: product.productId})
         ON CREATE SET p += {
           id: product.productId, title: product.title, titleEmbedding: product.titleEmbedding,
           description: product.description, descriptionSource: product.descriptionSource, content: product.content, product: product.product,
           characteristics: product.characteristics, styleCode: product.styleCode, styleData: product.styleData,
           styleBody: product.styleBody, stylePersonality: product.stylePersonality, styleChromatic: product.styleChromatic,
           is_neutral: product.is_neutral, neutral_whitelist: product.neutral_whitelist, color_vec: product.color_vec,
           image: product.image, images: product.images, vendor: product.vendor, currency: product.currency,
           category: product.category, handle: product.handle, status: product.status, storeId: product.storeId,
           contentEmbedding: product.contentEmbedding, productEmbedding: product.productEmbedding,
           characteristicsEmbedding: product.characteristicsEmbedding, categoryEmbedding: product.categoryEmbedding,
           styleCodeEmbedding: product.styleCodeEmbedding, searchAttributesText: product.searchAttributesText,
           searchAttributesEmbedding: product.searchAttributesEmbedding, updated_at: $nowIso,
           color: COALESCE(product.detectedColor, CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorValue ELSE null END),
           colorEmbedding: CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorEmbedding ELSE [] END,
           sizes: product.sizes,
           en_title: product.en_title, en_price: product.en_price, en_price_currency: product.en_price_currency,
           en_url: product.en_url, en_product_type: product.en_product_type, en_description: product.en_description, en_json: product.en_json,
           sku: product.sku
         }
         ON MATCH SET p += {
           id: product.productId, title: product.title, titleEmbedding: product.titleEmbedding,
           description: product.description, descriptionSource: product.descriptionSource, content: product.content, product: product.product,
           characteristics: product.characteristics, styleCode: product.styleCode, styleData: product.styleData,
           styleBody: product.styleBody, stylePersonality: product.stylePersonality, styleChromatic: product.styleChromatic,
           is_neutral: product.is_neutral, neutral_whitelist: product.neutral_whitelist, color_vec: product.color_vec,
           image: product.image, images: product.images, vendor: product.vendor, currency: product.currency,
           category: product.category, handle: product.handle, status: product.status, storeId: product.storeId,
           contentEmbedding: product.contentEmbedding, productEmbedding: product.productEmbedding,
           characteristicsEmbedding: product.characteristicsEmbedding, categoryEmbedding: product.categoryEmbedding,
           styleCodeEmbedding: product.styleCodeEmbedding, searchAttributesText: product.searchAttributesText,
           searchAttributesEmbedding: product.searchAttributesEmbedding, updated_at: $nowIso,
           color: COALESCE(product.detectedColor, CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorValue ELSE null END),
           colorEmbedding: CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorEmbedding ELSE [] END,
           sizes: product.sizes,
           en_title: product.en_title, en_price: product.en_price, en_price_currency: product.en_price_currency,
           en_url: product.en_url, en_product_type: product.en_product_type, en_description: product.en_description, en_json: product.en_json,
           sku: product.sku
         }
         WITH p, product
         UNWIND product.variants AS variant
         MERGE (v:Variant {id: variant.id})
         ON CREATE SET v += { id: variant.id, title: variant.title, price: variant.price, price_old: variant.compare_at_price,
           size: variant.sizeValue, color: variant.colorValue, sizeEmbedding: variant.sizeEmbedding, colorEmbedding: variant.colorEmbedding, inventoryQuantity: variant.inventory_quantity }
         ON MATCH SET v += { id: variant.id, title: variant.title, price: variant.price, price_old: variant.compare_at_price,
           size: variant.sizeValue, color: variant.colorValue, sizeEmbedding: variant.sizeEmbedding, colorEmbedding: variant.colorEmbedding, inventoryQuantity: variant.inventory_quantity }
         MERGE (p)-[:HAS_VARIANT]->(v)
         WITH p, product
         UNWIND product.collections AS collection
         MERGE (c:Category {name: toLower(collection.title)})
         MERGE (p)-[:HAS_CATEGORY]->(c)
         WITH p, product
         UNWIND split(product.tags, ",") AS tag WITH p, product, trim(tag) AS tag WHERE tag <> ""
         MERGE (c:Category {name: toLower(tag)}) MERGE (p)-[:HAS_CATEGORY]->(c)
         WITH p, product
         UNWIND product.demographics AS demographic MERGE (d:Demographic {name: demographic}) MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)
         WITH p, product.storeId AS storeId MATCH (store:Store {id: storeId}) MERGE (store)-[:HAS_PRODUCT]->(p)`,
        { newProducts, nowIso }
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
      titleEmbedding: p.titleEmbedding || [],
      description,
      descriptionSource,
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
      contentEmbedding: p.contentEmbedding || [],
      productEmbedding: p.productEmbedding || [],
      characteristicsEmbedding: p.characteristicsEmbedding || [],
      categoryEmbedding: p.categoryEmbedding || [],
      styleCodeEmbedding: p.styleCodeEmbedding || [],
      image: p.image,
      images,
      // Use product-specific detected demographics if available, otherwise use default
      demographics: p.detectedDemographics || demographicsData,
      currency: p.currency,
      collections: p.collections || [],
      tags: p.tags || "",
      styleBody,
      stylePersonality,
      styleChromatic,
      is_neutral,
      neutral_whitelist,
      color_vec,
      searchAttributesText: p.searchAttributesText || "",
      searchAttributesEmbedding: p.searchAttributesEmbedding || [],
      sizes: p.sizes || [],
      detectedColor: p.detectedColor || null,
      en_title: p.en_title || null,
      en_price: p.en_price || null,
      en_price_currency: p.en_price_currency || null,
      en_url: p.en_url || null,
      en_product_type: p.en_product_type || null,
      en_description: p.en_description || null,
      en_json: p.en_json || null,
      sku: p.sku || p.vtex?.productReference || null
    };
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
