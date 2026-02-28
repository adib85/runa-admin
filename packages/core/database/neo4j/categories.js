import neo4jClient from "./client.js";

/**
 * Category node operations in Neo4j
 */

/**
 * Create or update a category
 * @param {string} name - Category name
 * @param {Object} metadata - Optional metadata
 */
export async function upsertCategory(name, metadata = {}) {
  const normalizedName = name.toLowerCase().trim();

  await neo4jClient.run(
    `
    MERGE (c:Category {name: $name})
    ON CREATE SET c.createdAt = datetime()
    ON MATCH SET c.updatedAt = datetime()
    SET c += $metadata
    `,
    { name: normalizedName, metadata }
  );
}

/**
 * Bulk create categories
 * @param {Array<string>} names - Array of category names
 */
export async function bulkCreateCategories(names) {
  const normalizedNames = names.map((n) => n.toLowerCase().trim());

  await neo4jClient.run(
    `
    UNWIND $names AS name
    MERGE (c:Category {name: name})
    ON CREATE SET c.createdAt = datetime()
    `,
    { names: normalizedNames }
  );
}

/**
 * Get all categories
 * @returns {Promise<Array>} - Array of category objects
 */
export async function getAllCategories() {
  const records = await neo4jClient.run(
    `
    MATCH (c:Category)
    OPTIONAL MATCH (p:Product)-[:HAS_CATEGORY]->(c)
    RETURN c.name as name, count(p) as productCount
    ORDER BY productCount DESC
    `
  );

  return records.map((record) => ({
    name: record.get("name"),
    productCount: record.get("productCount").toNumber()
  }));
}

/**
 * Get categories for a specific store
 * @param {string} storeId - Store ID
 * @returns {Promise<Array>} - Categories with product counts
 */
export async function getCategoriesByStore(storeId) {
  const records = await neo4jClient.run(
    `
    MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)-[:HAS_CATEGORY]->(c:Category)
    RETURN c.name as name, count(DISTINCT p) as productCount
    ORDER BY productCount DESC
    `,
    { storeId }
  );

  return records.map((record) => ({
    name: record.get("name"),
    productCount: record.get("productCount").toNumber()
  }));
}

/**
 * Get products by category
 * @param {string} storeId - Store ID
 * @param {string} categoryName - Category name
 * @param {Object} options - { skip, limit }
 * @returns {Promise<Array>} - Products in the category
 */
export async function getProductsByCategory(storeId, categoryName, options = {}) {
  const { skip = 0, limit = 100 } = options;
  const normalizedName = categoryName.toLowerCase().trim();

  const records = await neo4jClient.run(
    `
    MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)-[:HAS_CATEGORY]->(c:Category {name: $categoryName})
    RETURN p
    ORDER BY p.title
    SKIP $skip
    LIMIT $limit
    `,
    { storeId, categoryName: normalizedName, skip, limit }
  );

  return records.map((record) => record.get("p").properties);
}

/**
 * Delete a category (removes relationships but not products)
 * @param {string} name - Category name
 */
export async function deleteCategory(name) {
  const normalizedName = name.toLowerCase().trim();

  await neo4jClient.run(
    `
    MATCH (c:Category {name: $name})
    DETACH DELETE c
    `,
    { name: normalizedName }
  );
}

/**
 * Rename a category
 * @param {string} oldName - Current category name
 * @param {string} newName - New category name
 */
export async function renameCategory(oldName, newName) {
  const normalizedOld = oldName.toLowerCase().trim();
  const normalizedNew = newName.toLowerCase().trim();

  await neo4jClient.run(
    `
    MATCH (c:Category {name: $oldName})
    SET c.name = $newName, c.updatedAt = datetime()
    `,
    { oldName: normalizedOld, newName: normalizedNew }
  );
}

export default {
  upsertCategory,
  bulkCreateCategories,
  getAllCategories,
  getCategoriesByStore,
  getProductsByCategory,
  deleteCategory,
  renameCategory
};
