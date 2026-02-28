import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import config from "@runa/config";
import { SHOPIFY_CATEGORIES } from "@runa/config/constants";

/**
 * Product classification using AI
 */

let openaiClient = null;
let geminiClient = null;

function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey
    });
  }
  return openaiClient;
}

function getGemini() {
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
  }
  return geminiClient;
}

/**
 * Classify a product into categories
 * @param {Object} product - Product object with title, description
 * @param {Array<string>} availableCategories - Categories to choose from
 * @param {Object} options - { provider: "openai" | "gemini" }
 * @returns {Promise<Object>} - { categories: string[], confidence: number }
 */
export async function classifyProduct(product, availableCategories = SHOPIFY_CATEGORIES, options = {}) {
  const { provider = "openai" } = options;

  const prompt = buildClassificationPrompt(product, availableCategories);

  if (provider === "gemini") {
    return classifyWithGemini(prompt);
  }

  return classifyWithOpenAI(prompt);
}

/**
 * Build classification prompt
 */
function buildClassificationPrompt(product, categories) {
  return `Analyze this product and classify it into the most appropriate categories.

Product:
- Title: ${product.title}
- Description: ${product.description || "N/A"}
${product.content ? `- Content: ${product.content.substring(0, 500)}` : ""}

Available Categories: ${categories.join(", ")}

Respond with a JSON object containing:
- categories: array of 1-3 most relevant category names from the list above
- primaryCategory: the single most relevant category
- demographics: array of target demographics (e.g., "women", "men", "unisex", "kids")
- characteristics: object with extracted attributes like color, material, style, occasion, season

Example response:
{
  "categories": ["Dresses", "Clothing"],
  "primaryCategory": "Dresses",
  "demographics": ["women"],
  "characteristics": {
    "color": "black",
    "material": "cotton",
    "style": "casual",
    "occasion": "everyday",
    "season": "all-season"
  }
}

Respond ONLY with valid JSON, no other text.`;
}

/**
 * Classify using OpenAI
 */
async function classifyWithOpenAI(prompt) {
  const openai = getOpenAI();

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.chatModel,
      messages: [
        {
          role: "system",
          content: "You are a product classification expert. Always respond with valid JSON only."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0].message.content.trim();
    return parseClassificationResponse(content, response.usage);
  } catch (error) {
    console.error("OpenAI classification error:", error);
    return getDefaultClassification();
  }
}

/**
 * Classify using Gemini
 */
async function classifyWithGemini(prompt) {
  const gemini = getGemini();
  const model = gemini.getGenerativeModel({ model: config.gemini.model });

  try {
    const result = await model.generateContent(prompt);
    const content = result.response.text().trim();
    return parseClassificationResponse(content, result.response.usageMetadata);
  } catch (error) {
    console.error("Gemini classification error:", error);
    return getDefaultClassification();
  }
}

/**
 * Parse AI response to classification object
 */
function parseClassificationResponse(content, usage) {
  try {
    // Clean up the response (remove markdown code blocks if present)
    let cleaned = content;
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    }
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }

    const parsed = JSON.parse(cleaned.trim());

    return {
      categories: parsed.categories || [],
      primaryCategory: parsed.primaryCategory || parsed.categories?.[0] || null,
      demographics: parsed.demographics || [],
      characteristics: parsed.characteristics || {},
      usage
    };
  } catch (error) {
    console.error("Failed to parse classification response:", error);
    console.error("Raw content:", content);
    return getDefaultClassification();
  }
}

/**
 * Get default classification when AI fails
 */
function getDefaultClassification() {
  return {
    categories: [],
    primaryCategory: null,
    demographics: [],
    characteristics: {},
    usage: null
  };
}

/**
 * Batch classify products
 * @param {Array<Object>} products - Array of products
 * @param {Array<string>} availableCategories - Categories to choose from
 * @param {Object} options - { provider, concurrency }
 * @returns {Promise<Array<Object>>} - Array of classification results
 */
export async function classifyProducts(products, availableCategories = SHOPIFY_CATEGORIES, options = {}) {
  const { concurrency = 5 } = options;
  const results = [];

  // Process in batches for controlled concurrency
  for (let i = 0; i < products.length; i += concurrency) {
    const batch = products.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((product) => classifyProduct(product, availableCategories, options))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Extract product properties/style codes (matching existing system)
 * @param {string} aggregatedContent - Combined product text
 * @param {Array<string>} defaultCategories - Available categories
 * @returns {Promise<Object>} - Extracted properties
 */
export async function getProductProperties(aggregatedContent, defaultCategories = SHOPIFY_CATEGORIES) {
  const prompt = `Analyze this product content and extract properties:

Content: ${aggregatedContent.substring(0, 2000)}

Categories to choose from: ${defaultCategories.join(", ")}

Return a JSON object with:
- category: primary category from the list
- categories: array of relevant categories
- demographic: target audience (women, men, unisex, kids)
- styleCode: object with body_shape, personality, chromatic codes
- color: primary color
- material: primary material
- occasion: suitable occasion
- season: suitable season

Respond ONLY with valid JSON.`;

  return classifyWithOpenAI(prompt);
}

export default {
  classifyProduct,
  classifyProducts,
  getProductProperties
};
