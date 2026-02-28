import neo4jClient from "./client.js";

/**
 * Application and Store node operations in Neo4j
 */

/**
 * Create or update an Application node
 * @param {string} appId - Application ID
 * @param {string} appName - Application name
 */
export async function createApplication(appId, appName) {
  await neo4jClient.run(
    `
    MERGE (app:Application {id: $appId})
    ON CREATE SET app.name = $appName, app.createdAt = datetime()
    ON MATCH SET app.name = $appName, app.updatedAt = datetime()
    `,
    { appId, appName }
  );
}

/**
 * Create or update a Store node and link to Application
 * @param {string} storeId - Store ID (usually the shop domain)
 * @param {string} storeName - Store display name
 * @param {string} appId - Parent application ID
 */
export async function createStore(storeId, storeName, appId) {
  await neo4jClient.run(
    `
    MERGE (store:Store {id: $storeId})
    ON CREATE SET store.name = $storeName, store.createdAt = datetime()
    ON MATCH SET store.name = $storeName, store.updatedAt = datetime()
    WITH store
    MATCH (app:Application {id: $appId})
    MERGE (app)-[:HAS_STORE]->(store)
    `,
    { storeId, storeName, appId }
  );
}

/**
 * Create both Application and Store in a single transaction
 * @param {Object} storeData - { id, storeName }
 * @param {Object} appData - { id, appName }
 */
export async function createApplicationAndStore(storeData, appData) {
  const { id: storeId, storeName } = storeData;
  const { id: appId, appName } = appData;

  await neo4jClient.withTransaction(async (tx) => {
    // Create Application
    await tx.run(
      `
      MERGE (app:Application {id: $appId})
      ON CREATE SET app.name = $appName, app.createdAt = datetime()
      ON MATCH SET app.name = $appName, app.updatedAt = datetime()
      `,
      { appId, appName }
    );

    // Create Store and link to Application
    await tx.run(
      `
      MERGE (store:Store {id: $storeId})
      ON CREATE SET store.name = $storeName, store.createdAt = datetime()
      ON MATCH SET store.name = $storeName, store.updatedAt = datetime()
      WITH store
      MATCH (app:Application {id: $appId})
      MERGE (app)-[:HAS_STORE]->(store)
      `,
      { storeId, storeName, appId }
    );
  });

  console.log(`Created/updated Application "${appId}" with Store "${storeId}"`);
}

/**
 * Get all stores for an application
 * @param {string} appId - Application ID
 * @returns {Promise<Array>} - List of store objects
 */
export async function getStoresByApplication(appId) {
  const records = await neo4jClient.run(
    `
    MATCH (app:Application {id: $appId})-[:HAS_STORE]->(store:Store)
    RETURN store.id as id, store.name as name, store.createdAt as createdAt
    `,
    { appId }
  );

  return records.map((record) => ({
    id: record.get("id"),
    name: record.get("name"),
    createdAt: record.get("createdAt")
  }));
}

/**
 * Delete a store and all its products
 * @param {string} storeId - Store ID to delete
 */
export async function deleteStore(storeId) {
  await neo4jClient.withTransaction(async (tx) => {
    // Delete all products and their relationships
    await tx.run(
      `
      MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)
      DETACH DELETE p
      `,
      { storeId }
    );

    // Delete the store
    await tx.run(
      `
      MATCH (store:Store {id: $storeId})
      DETACH DELETE store
      `,
      { storeId }
    );
  });

  console.log(`Deleted store "${storeId}" and all its products`);
}

export default {
  createApplication,
  createStore,
  createApplicationAndStore,
  getStoresByApplication,
  deleteStore
};
