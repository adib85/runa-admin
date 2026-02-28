import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import dynamoClient from "./client.js";
import crypto from "crypto";

const TABLE_NAME = dynamoClient.getTables().cache;

/**
 * Cache operations in DynamoDB
 * Used for caching embeddings, API responses, etc.
 */

/**
 * Generate a hash key for cache entries
 * @param {string} input - Input string to hash
 * @returns {string} - SHA256 hash
 */
export function hashKey(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Get cached value
 * @param {string} key - Cache key
 * @returns {Promise<any|null>} - Cached value or null
 */
export async function get(key) {
  const docClient = dynamoClient.getDocClient();

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id: key }
      })
    );

    if (!result.Item) return null;

    // Check TTL expiration
    if (result.Item.ttl && result.Item.ttl < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return result.Item.value;
  } catch (error) {
    console.error("Cache get error:", error);
    return null;
  }
}

/**
 * Set cached value
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {Object} options - { ttl: seconds }
 */
export async function set(key, value, options = {}) {
  const docClient = dynamoClient.getDocClient();
  const { ttl } = options;

  const item = {
    id: key,
    value,
    createdAt: new Date().toISOString()
  };

  // Add TTL if specified (DynamoDB TTL is in seconds since epoch)
  if (ttl) {
    item.ttl = Math.floor(Date.now() / 1000) + ttl;
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );
  } catch (error) {
    console.error("Cache set error:", error);
  }
}

/**
 * Delete cached value
 * @param {string} key - Cache key
 */
export async function del(key) {
  const docClient = dynamoClient.getDocClient();

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id: key }
      })
    );
  } catch (error) {
    console.error("Cache delete error:", error);
  }
}

/**
 * Get or set pattern - returns cached value or executes factory and caches result
 * @param {string} key - Cache key
 * @param {Function} factory - Async function to generate value if not cached
 * @param {Object} options - { ttl: seconds }
 * @returns {Promise<any>} - Cached or newly generated value
 */
export async function getOrSet(key, factory, options = {}) {
  const cached = await get(key);
  if (cached !== null) {
    return cached;
  }

  const value = await factory();
  await set(key, value, options);
  return value;
}

/**
 * Cache embedding with auto-generated key
 * @param {string} text - Text that was embedded
 * @param {Array} embedding - Embedding vector
 * @param {number} ttl - TTL in seconds (default 30 days)
 */
export async function cacheEmbedding(text, embedding, ttl = 86400 * 30) {
  const key = `emb:${hashKey(text)}`;
  await set(key, embedding, { ttl });
}

/**
 * Get cached embedding
 * @param {string} text - Text to look up
 * @returns {Promise<Array|null>} - Embedding vector or null
 */
export async function getCachedEmbedding(text) {
  const key = `emb:${hashKey(text)}`;
  return get(key);
}

export default {
  hashKey,
  get,
  set,
  del,
  getOrSet,
  cacheEmbedding,
  getCachedEmbedding
};
