import dotenv from "dotenv";
dotenv.config();

/**
 * Centralized configuration for the entire application.
 * All external service credentials and settings in one place.
 */
export const config = {
  // Neo4j Graph Database
  neo4j: {
    uri: process.env.NEO4J_URI || "neo4j://3.95.143.107:7687",
    user: process.env.NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD,
    maxConnectionPoolSize: 50,
    connectionTimeout: 30000
  },

  // AWS General
  aws: {
    region: process.env.AWS_REGION || "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },

  // DynamoDB Tables
  dynamodb: {
    tables: {
      users: process.env.DYNAMODB_USER_TABLE || "UserTable",
      logs: process.env.DYNAMODB_LOG_TABLE || "LogTable",
      cache: process.env.DYNAMODB_CACHE_TABLE || "CacheTable"
    }
  },

  // S3 Storage
  s3: {
    bucket: process.env.S3_BUCKET || "traveline-images",
    keyPrefix: process.env.S3_KEY_PREFIX || "uploads/",
    region: process.env.AWS_REGION || "us-east-1"
  },

  // PubNub Real-time Messaging
  pubnub: {
    publishKey: process.env.PUBNUB_PUBLISH_KEY,
    subscribeKey: process.env.PUBNUB_SUBSCRIBE_KEY,
    uuid: "runa-admin"
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingModel: "text-embedding-3-small",
    chatModel: "gpt-4o-mini"
  },

  // Google Gemini
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    groundingApiKeys: (process.env.GEMINI_GROUNDING_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean),
    model: "gemini-3-flash-preview"
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || "3001", 10),
    env: process.env.NODE_ENV || "development"
  },

  // Shopify API
  shopify: {
    apiVersion: "2024-07"
  },

  // Sync Settings
  sync: {
    batchSize: 50,
    concurrency: 5,
    retryAttempts: 3,
    retryDelay: 1000
  }
};

export default config;
