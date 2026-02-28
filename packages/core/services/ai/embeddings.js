import OpenAI from "openai";
import config from "@runa/config";
import * as cache from "../../database/dynamodb/cache.js";

/**
 * Embedding service with caching
 */

let openaiClient = null;

function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey
    });
  }
  return openaiClient;
}

/**
 * Generate embedding for text with caching
 * @param {string} text - Text to embed
 * @param {Object} options - { useCache: boolean, cacheTTL: seconds }
 * @returns {Promise<Array<number>>} - Embedding vector
 */
export async function generateEmbedding(text, options = {}) {
  const { useCache = true, cacheTTL = 86400 * 30 } = options;

  if (!text || text.trim().length === 0) {
    return null;
  }

  const normalizedText = text.trim().substring(0, 8000); // OpenAI limit

  // Check cache first
  if (useCache) {
    const cached = await cache.getCachedEmbedding(normalizedText);
    if (cached) {
      return cached;
    }
  }

  // Generate new embedding
  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: normalizedText
  });

  const embedding = response.data[0].embedding;

  // Cache the result
  if (useCache) {
    await cache.cacheEmbedding(normalizedText, embedding, cacheTTL);
  }

  return embedding;
}

/**
 * Generate embeddings for multiple texts (batch)
 * @param {Array<string>} texts - Array of texts to embed
 * @param {Object} options - { useCache: boolean, cacheTTL: seconds }
 * @returns {Promise<Array<Array<number>>>} - Array of embedding vectors
 */
export async function generateEmbeddings(texts, options = {}) {
  const { useCache = true, cacheTTL = 86400 * 30 } = options;

  const results = [];
  const uncachedTexts = [];
  const uncachedIndices = [];

  // Check cache for each text
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]?.trim();
    if (!text) {
      results[i] = null;
      continue;
    }

    if (useCache) {
      const cached = await cache.getCachedEmbedding(text);
      if (cached) {
        results[i] = cached;
        continue;
      }
    }

    uncachedTexts.push(text.substring(0, 8000));
    uncachedIndices.push(i);
  }

  // Generate embeddings for uncached texts
  if (uncachedTexts.length > 0) {
    const openai = getOpenAI();

    // Process in batches of 100 (OpenAI limit)
    const batchSize = 100;
    for (let i = 0; i < uncachedTexts.length; i += batchSize) {
      const batch = uncachedTexts.slice(i, i + batchSize);
      const batchIndices = uncachedIndices.slice(i, i + batchSize);

      const response = await openai.embeddings.create({
        model: config.openai.embeddingModel,
        input: batch
      });

      // Map results back and cache
      for (let j = 0; j < response.data.length; j++) {
        const embedding = response.data[j].embedding;
        const originalIndex = batchIndices[j];
        results[originalIndex] = embedding;

        if (useCache) {
          await cache.cacheEmbedding(batch[j], embedding, cacheTTL);
        }
      }
    }
  }

  return results;
}

/**
 * Generate content embedding for a product
 * Combines title, description, and other relevant text
 * @param {Object} product - Product object
 * @returns {Promise<Array<number>>} - Embedding vector
 */
export async function generateProductContentEmbedding(product) {
  const { title, description, content } = product;

  const combinedText = [title, description, content].filter(Boolean).join(" ");

  return generateEmbedding(combinedText);
}

/**
 * Generate characteristics embedding for a product
 * Focuses on attributes like color, material, style
 * @param {Object} product - Product object
 * @param {Object} characteristics - Extracted characteristics
 * @returns {Promise<Array<number>>} - Embedding vector
 */
export async function generateProductCharacteristicsEmbedding(product, characteristics) {
  const parts = [];

  if (characteristics.color) parts.push(`color: ${characteristics.color}`);
  if (characteristics.material) parts.push(`material: ${characteristics.material}`);
  if (characteristics.style) parts.push(`style: ${characteristics.style}`);
  if (characteristics.occasion) parts.push(`occasion: ${characteristics.occasion}`);
  if (characteristics.season) parts.push(`season: ${characteristics.season}`);

  if (parts.length === 0) return null;

  return generateEmbedding(parts.join(", "));
}

export default {
  generateEmbedding,
  generateEmbeddings,
  generateProductContentEmbedding,
  generateProductCharacteristicsEmbedding
};
