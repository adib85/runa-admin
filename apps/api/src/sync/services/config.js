/**
 * Shared configuration for sync services
 * EXACT values from original runa_server/crawler
 */

import dotenv from "dotenv";
dotenv.config();

export const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
export const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
export const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export const PUBNUB_CONFIG = {
  publishKey: process.env.PUBNUB_PUBLISH_KEY,
  subscribeKey: process.env.PUBNUB_SUBSCRIBE_KEY,
  uuid: "main",
  autoNetworkDetection: true,
  restore: true
};

export const S3_CONFIG = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET || 'traveline-images',
  keyPrefix: 'uploads/'
};

export const AWS_REGION = "us-east-1";
export const DYNAMODB_USER_TABLE = "UserTable";
