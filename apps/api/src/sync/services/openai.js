/**
 * OpenAI Service
 * Handles embeddings and AI-powered product analysis
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../../../.env") });

import OpenAI from "openai";
import fetch from "node-fetch";
import { OPENAI_API_KEY } from "./config.js";

class OpenAIService {
  constructor() {
    this.apiKey = OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!this.apiKey) {
      throw new Error(`OPENAI_API_KEY is missing. Make sure .env exists at ${resolve(__dirname, "../../../../../.env")}`);
    }
    this.client = new OpenAI({ apiKey: this.apiKey });
    this.embeddingCache = [];
  }

  async generateEmbedding(inputText) {
    if (!inputText) return null;
    const url = "https://api.openai.com/v1/embeddings";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: inputText })
      });
      const data = await response.json();
      return data?.data?.[0]?.embedding || null;
    } catch (e) {
      console.log("error generateEmbedding", e.message);
      return null;
    }
  }

  async getProductProperties(aggregatedContent, defaultCategories, websiteCategories, maxRetries = 2) {
    let retries = 0;
    const categories = defaultCategories || websiteCategories;

    const requestSummary = async () => {
      const messages = [
        {
          role: "system",
          content: `
            Extract from the prompt provided the following information and return a JSON of this type:
            {
              "product": "Item detailed type, for example 'high waist pants', 'maxi dress', 'slim fit jeans'",
              "characteristics": "if present, item characteristics, for example, 'cotton', 'low rise'",
              "color": "if present, the color of the item",
              "material": "if present, the material of the item",
              "brand": "if present, the brand of the item",
              "demographic": "target demographic group for the product: 'woman', 'man'",
              "category": "A category from this list: ${categories.join(", ")}."
            }

            Important: "product", "characteristics", "color", "demographic" and "category" are mandatory

            Examples of "product" and "characteristics":
            product – High rise wide leg jeans, Washed low rise flare jeans, Cargo jeans, Slouchy full-length jeans
            characteristics – cotton, decorative belt, embellishments, front pockets, relaxed, raw hem, cuff details

            Respond in the same language as the prompt except for the category which must be from the provided list.
          `
        },
        { role: "user", content: aggregatedContent }
      ];

      try {
        const response = await this.client.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          temperature: 0.7,
          max_tokens: 4096,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "product_properties_extraction",
              strict: false,
              schema: {
                type: "object",
                properties: {
                  product: { type: "string" },
                  characteristics: { type: "string" },
                  color: { type: "string" },
                  material: { type: "string" },
                  brand: { type: "string" },
                  demographic: { type: "string", enum: ["woman", "man"] },
                  category: { type: "string" }
                },
                required: ["product", "characteristics", "color", "demographic", "category"],
                additionalProperties: false
              }
            }
          }
        });
        return response.choices[0].message.content;
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          return requestSummary();
        }
        throw error;
      }
    };

    return requestSummary();
  }

  async generateSuggestions(categoriesList) {
    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a highly knowledgeable assistant who will receive a summary of a website's content, organized by categories. Your task is to generate a JSON with 3 short conversation starters designed to enhance the shopping experience on the website.

          Example JSON Output:
          {
            "suggestions": [
              "Casual outfit for outdoors",
              "Slim fit blue jeans",
              "Breezy tops"
            ]
          }

          Each suggestion should be straightforward and tailored to guide users on what to search for or ask about, with at least one prompt being 3-4 words long.`
        },
        { role: "user", content: categoriesList }
      ],
      temperature: 0.7,
      max_tokens: 4096,
      response_format: { type: "json_object" }
    });

    return response.choices[0].message.content;
  }

  getCachedEmbedding(key) {
    return this.embeddingCache.find(e => e.id === key)?.value;
  }

  cacheEmbedding(key, value) {
    if (value) {
      this.embeddingCache.push({ id: key, value });
    }
  }

  clearCache() {
    this.embeddingCache = [];
  }
}

export default new OpenAIService();
