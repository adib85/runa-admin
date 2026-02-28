import neo4jClient from "./client.js";

/**
 * Product node operations in Neo4j
 */

/**
 * Create or update a product with its variants, categories, and embeddings
 * @param {string} storeId - Store ID
 * @param {Object} product - Product data
 */
export async function upsertProduct(storeId, product) {
  const {
    id,
    title,
    description,
    content,
    handle,
    image,
    currency,
    contentEmbedding,
    characteristicsEmbedding,
    variants = [],
    categories = [],
    demographics = []
  } = product;

  await neo4jClient.withTransaction(async (tx) => {
    // Create/update the product
    await tx.run(
      `
      MATCH (store:Store {id: $storeId})
      MERGE (p:Product {id: $id})
      ON CREATE SET
        p.title = $title,
        p.description = $description,
        p.content = $content,
        p.handle = $handle,
        p.image = $image,
        p.currency = $currency,
        p.createdAt = datetime()
      ON MATCH SET
        p.title = $title,
        p.description = $description,
        p.content = $content,
        p.handle = $handle,
        p.image = $image,
        p.currency = $currency,
        p.updatedAt = datetime()
      MERGE (store)-[:HAS_PRODUCT]->(p)
      `,
      { storeId, id, title, description, content, handle, image, currency }
    );

    // Set embeddings if provided
    if (contentEmbedding) {
      await tx.run(
        `
        MATCH (p:Product {id: $id})
        SET p.contentEmbedding = $contentEmbedding
        `,
        { id, contentEmbedding }
      );
    }

    if (characteristicsEmbedding) {
      await tx.run(
        `
        MATCH (p:Product {id: $id})
        SET p.characteristicsEmbedding = $characteristicsEmbedding
        `,
        { id, characteristicsEmbedding }
      );
    }

    // Remove existing variants and create new ones
    await tx.run(
      `
      MATCH (p:Product {id: $id})-[r:HAS_VARIANT]->(v:Variant)
      DELETE r, v
      `,
      { id }
    );

    for (const variant of variants) {
      await tx.run(
        `
        MATCH (p:Product {id: $productId})
        CREATE (v:Variant {
          id: $variantId,
          color: $color,
          size: $size,
          price: $price,
          compareAtPrice: $compareAtPrice,
          sku: $sku,
          available: $available
        })
        MERGE (p)-[:HAS_VARIANT]->(v)
        `,
        {
          productId: id,
          variantId: variant.id,
          color: variant.color || "",
          size: variant.size || "",
          price: variant.price || 0,
          compareAtPrice: variant.compareAtPrice || null,
          sku: variant.sku || "",
          available: variant.available !== false
        }
      );

      // Set variant embeddings if provided
      if (variant.colorEmbedding) {
        await tx.run(
          `
          MATCH (v:Variant {id: $variantId})
          SET v.colorEmbedding = $colorEmbedding
          `,
          { variantId: variant.id, colorEmbedding: variant.colorEmbedding }
        );
      }
    }

    // Update categories
    await tx.run(
      `
      MATCH (p:Product {id: $id})-[r:HAS_CATEGORY]->()
      DELETE r
      `,
      { id }
    );

    for (const categoryName of categories) {
      await tx.run(
        `
        MATCH (p:Product {id: $productId})
        MERGE (c:Category {name: $categoryName})
        MERGE (p)-[:HAS_CATEGORY]->(c)
        `,
        { productId: id, categoryName: categoryName.toLowerCase() }
      );
    }

    // Update demographics
    await tx.run(
      `
      MATCH (p:Product {id: $id})-[r:HAS_DEMOGRAPHIC]->()
      DELETE r
      `,
      { id }
    );

    for (const demographicName of demographics) {
      await tx.run(
        `
        MATCH (p:Product {id: $productId})
        MERGE (d:Demographic {name: $demographicName})
        MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)
        `,
        { productId: id, demographicName: demographicName.toLowerCase() }
      );
    }
  });
}

/**
 * Bulk upsert products (more efficient for large imports)
 * @param {string} storeId - Store ID
 * @param {Array} products - Array of product objects
 */
export async function bulkUpsertProducts(storeId, products) {
  for (const product of products) {
    await upsertProduct(storeId, product);
  }
}

/**
 * Get product by ID
 * @param {string} productId - Product ID
 * @returns {Promise<Object|null>} - Product data or null
 */
export async function getProduct(productId) {
  const records = await neo4jClient.run(
    `
    MATCH (p:Product {id: $productId})
    OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
    OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(c:Category)
    RETURN p, collect(DISTINCT v) as variants, collect(DISTINCT c.name) as categories
    `,
    { productId }
  );

  if (records.length === 0) return null;

  const record = records[0];
  const product = record.get("p").properties;
  product.variants = record.get("variants").map((v) => v.properties);
  product.categories = record.get("categories");

  return product;
}

/**
 * Get all products for a store
 * @param {string} storeId - Store ID
 * @param {Object} options - { skip, limit }
 * @returns {Promise<Array>} - Array of products
 */
export async function getProductsByStore(storeId, options = {}) {
  const { skip = 0, limit = 100 } = options;

  const records = await neo4jClient.run(
    `
    MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
    RETURN p
    ORDER BY p.title
    SKIP $skip
    LIMIT $limit
    `,
    { storeId, skip: neo4jClient.getDriver().int(skip), limit: neo4jClient.getDriver().int(limit) }
  );

  return records.map((record) => record.get("p").properties);
}

/**
 * Count products in a store
 * @param {string} storeId - Store ID
 * @returns {Promise<number>} - Product count
 */
export async function countProductsByStore(storeId) {
  const records = await neo4jClient.run(
    `
    MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
    RETURN count(p) as count
    `,
    { storeId }
  );

  return records[0]?.get("count")?.toNumber() || 0;
}

/**
 * Delete a product
 * @param {string} productId - Product ID
 */
export async function deleteProduct(productId) {
  await neo4jClient.run(
    `
    MATCH (p:Product {id: $productId})
    OPTIONAL MATCH (p)-[:HAS_VARIANT]->(v:Variant)
    DETACH DELETE p, v
    `,
    { productId }
  );
}

/**
 * Search products by embedding similarity (cosine)
 * @param {string} storeId - Store ID
 * @param {Array} embedding - Query embedding vector
 * @param {number} limit - Max results
 * @returns {Promise<Array>} - Matching products with scores
 */
export async function searchByEmbedding(storeId, embedding, limit = 10) {
  const records = await neo4jClient.run(
    `
    MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
    WHERE p.contentEmbedding IS NOT NULL
    WITH p, gds.similarity.cosine(p.contentEmbedding, $embedding) AS score
    ORDER BY score DESC
    LIMIT $limit
    RETURN p, score
    `,
    { storeId, embedding, limit }
  );

  return records.map((record) => ({
    product: record.get("p").properties,
    score: record.get("score")
  }));
}

export default {
  upsertProduct,
  bulkUpsertProducts,
  getProduct,
  getProductsByStore,
  countProductsByStore,
  deleteProduct,
  searchByEmbedding
};
