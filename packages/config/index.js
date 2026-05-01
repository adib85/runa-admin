import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../.env") });

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
      cache: process.env.DYNAMODB_CACHE_TABLE || "CacheTable",
      leadsCompany: process.env.DYNAMODB_LEADS_COMPANY_TABLE || "LeadsCompanyTable",
      leadsContact: process.env.DYNAMODB_LEADS_CONTACT_TABLE || "LeadsContactTable"
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
    model: "gemini-3-flash-preview",
    liteModel: "gemini-3.1-flash-lite-preview"
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || "3001", 10),
    env: process.env.NODE_ENV || "development"
  },

  // Web (used to build links in transactional emails, etc.)
  web: {
    url: process.env.WEB_URL || "http://localhost:3000"
  },

  // SendGrid (transactional email)
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY || "",
    fromEmail: process.env.SENDGRID_FROM_EMAIL || "noreply@askruna.ai",
    fromName: process.env.SENDGRID_FROM_NAME || "Runa"
  },

  // Claim tokens (used by the Shopify install side to hand off a freshly
  // installed shop to the runa-admin "set up your account" page).
  // The Shopify install backend signs a JWT with the same secret; runa-admin
  // verifies it on the /api/auth/claim endpoint.
  claim: {
    secret:
      process.env.CLAIM_TOKEN_SECRET ||
      "runa-claim-secret-change-in-production",
    ttl: process.env.CLAIM_TOKEN_TTL || "7d"
  },

  // Superadmin elevation. Visit `/?superadmin=<key>` while logged in to swap
  // your own JWT for one that carries role: "superadmin". Empty / unset
  // disables the feature entirely. Use a long random string in production
  // (openssl rand -hex 24) and treat it like a password.
  superadmin: {
    key: process.env.SUPERADMIN_KEY || ""
  },

  // Internal ops notifications. We email this address whenever a new merchant
  // shows up (registers via /register or claims via the Shopify SSO link).
  // Comma-separated; empty disables the feature.
  notifications: {
    newMerchantTo: process.env.NEW_MERCHANT_NOTIFY || "adrian@askruna.ai"
  },

  // Shopify API
  shopify: {
    apiVersion: "2025-10",
    // Used to build the auto-activate theme editor URL — Shopify accepts
    // `?activateAppId=<APP_KEY>/<HANDLE>` to pre-toggle the embed on so the
    // merchant only has to click Save. Defaults match the Runa Shopify app
    // (shopify.app.toml client_id + app-embed.liquid block name).
    appKey:
      process.env.SHOPIFY_APP_KEY ||
      "9d0ddc183253fd6b4df65b810d274dc5",
    appEmbedHandle: process.env.SHOPIFY_APP_EMBED_HANDLE || "app-embed"
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
