import { PRICING } from "@runa/config/constants";

/**
 * Track and calculate AI API costs
 */

/**
 * Calculate OpenAI GPT cost from usage
 * @param {Object} usage - OpenAI usage object
 * @param {string} model - Model name
 * @returns {Object} - Cost breakdown
 */
export function calculateOpenAICost(usage, model = "gpt-4o-mini") {
  if (!usage) {
    return {
      inputUSD: 0,
      outputUSD: 0,
      totalUSD: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0
    };
  }

  const pricing = PRICING.openai[model];
  if (!pricing) {
    console.warn(`Unknown model pricing: ${model}`);
    return { inputUSD: 0, outputUSD: 0, totalUSD: 0 };
  }

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const cachedTokens =
    (usage.prompt_tokens_details?.cached_tokens) ||
    usage.cached_prompt_tokens ||
    0;

  const normalPromptTokens = Math.max(promptTokens - cachedTokens, 0);

  const inputUSD =
    normalPromptTokens * pricing.inputPerTokenUSD +
    cachedTokens * (pricing.cachedInputPerTokenUSD || pricing.inputPerTokenUSD);
  const outputUSD = completionTokens * pricing.outputPerTokenUSD;
  const totalUSD = inputUSD + outputUSD;

  return {
    inputUSD: parseFloat(inputUSD.toFixed(6)),
    outputUSD: parseFloat(outputUSD.toFixed(6)),
    totalUSD: parseFloat(totalUSD.toFixed(6)),
    promptTokens,
    completionTokens,
    cachedTokens,
    normalPromptTokens
  };
}

/**
 * Calculate OpenAI embedding cost
 * @param {number} tokens - Number of tokens
 * @param {string} model - Model name
 * @returns {Object} - Cost breakdown
 */
export function calculateEmbeddingCost(tokens, model = "text-embedding-3-small") {
  const pricing = PRICING.openai[model];
  if (!pricing) {
    return { totalUSD: 0, tokens: 0 };
  }

  const totalUSD = tokens * pricing.inputPerTokenUSD;

  return {
    totalUSD: parseFloat(totalUSD.toFixed(6)),
    tokens
  };
}

/**
 * Calculate Gemini cost from usage
 * @param {Object} usageMetadata - Gemini usage metadata
 * @param {string} model - Model name
 * @returns {Object} - Cost breakdown
 */
export function calculateGeminiCost(usageMetadata, model = "gemini-2.5-flash-preview-09-2025") {
  if (!usageMetadata) {
    return {
      inputUSD: 0,
      outputUSD: 0,
      totalUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0
    };
  }

  const pricing = PRICING.gemini[model];
  if (!pricing) {
    console.warn(`Unknown Gemini model pricing: ${model}`);
    return { inputUSD: 0, outputUSD: 0, totalUSD: 0 };
  }

  const inputTokens = usageMetadata.promptTokenCount || usageMetadata.promptTokens || 0;
  const candidatesTokens = usageMetadata.candidatesTokenCount || usageMetadata.completionTokens || 0;
  const thinkingTokens = usageMetadata.thoughtsTokenCount || 0;

  const outputTokens = candidatesTokens + thinkingTokens;
  const totalTokens = usageMetadata.totalTokenCount || (inputTokens + outputTokens);

  const inputUSD = (inputTokens / 1e6) * (pricing.inputPerTokenUSD * 1e6);
  const outputUSD = (outputTokens / 1e6) * (pricing.outputPerTokenUSD * 1e6);
  const totalUSD = inputUSD + outputUSD;

  return {
    inputUSD: parseFloat(inputUSD.toFixed(6)),
    outputUSD: parseFloat(outputUSD.toFixed(6)),
    totalUSD: parseFloat(totalUSD.toFixed(6)),
    inputTokens,
    outputTokens,
    thinkingTokens,
    totalTokens
  };
}

/**
 * Cost tracker class for accumulating costs across operations
 */
export class CostTracker {
  constructor() {
    this.costs = {
      openai: { chat: 0, embeddings: 0 },
      gemini: 0,
      total: 0
    };
    this.usage = {
      openai: { promptTokens: 0, completionTokens: 0, embeddingTokens: 0 },
      gemini: { inputTokens: 0, outputTokens: 0 }
    };
  }

  /**
   * Add OpenAI chat cost
   */
  addOpenAIChatCost(usage, model = "gpt-4o-mini") {
    const cost = calculateOpenAICost(usage, model);
    this.costs.openai.chat += cost.totalUSD;
    this.costs.total += cost.totalUSD;
    this.usage.openai.promptTokens += cost.promptTokens;
    this.usage.openai.completionTokens += cost.completionTokens;
    return cost;
  }

  /**
   * Add OpenAI embedding cost
   */
  addEmbeddingCost(tokens, model = "text-embedding-3-small") {
    const cost = calculateEmbeddingCost(tokens, model);
    this.costs.openai.embeddings += cost.totalUSD;
    this.costs.total += cost.totalUSD;
    this.usage.openai.embeddingTokens += tokens;
    return cost;
  }

  /**
   * Add Gemini cost
   */
  addGeminiCost(usageMetadata, model = "gemini-2.5-flash-preview-09-2025") {
    const cost = calculateGeminiCost(usageMetadata, model);
    this.costs.gemini += cost.totalUSD;
    this.costs.total += cost.totalUSD;
    this.usage.gemini.inputTokens += cost.inputTokens;
    this.usage.gemini.outputTokens += cost.outputTokens;
    return cost;
  }

  /**
   * Get summary
   */
  getSummary() {
    return {
      costs: {
        openaiChat: parseFloat(this.costs.openai.chat.toFixed(4)),
        openaiEmbeddings: parseFloat(this.costs.openai.embeddings.toFixed(4)),
        gemini: parseFloat(this.costs.gemini.toFixed(4)),
        total: parseFloat(this.costs.total.toFixed(4))
      },
      usage: this.usage
    };
  }

  /**
   * Reset tracker
   */
  reset() {
    this.costs = { openai: { chat: 0, embeddings: 0 }, gemini: 0, total: 0 };
    this.usage = {
      openai: { promptTokens: 0, completionTokens: 0, embeddingTokens: 0 },
      gemini: { inputTokens: 0, outputTokens: 0 }
    };
  }
}

export default {
  calculateOpenAICost,
  calculateEmbeddingCost,
  calculateGeminiCost,
  CostTracker
};
