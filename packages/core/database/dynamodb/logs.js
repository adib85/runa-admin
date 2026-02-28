import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import dynamoClient from "./client.js";
import { v4 as uuidv4 } from "uuid";

const TABLE_NAME = dynamoClient.getTables().logs;

/**
 * Log operations in DynamoDB
 * Used for tracking sync jobs, errors, and activity
 */

/**
 * Log levels
 */
export const LOG_LEVELS = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error"
};

/**
 * Log types
 */
export const LOG_TYPES = {
  SYNC_START: "sync_start",
  SYNC_PROGRESS: "sync_progress",
  SYNC_COMPLETE: "sync_complete",
  SYNC_ERROR: "sync_error",
  PRODUCT_PROCESSED: "product_processed",
  PRODUCT_ERROR: "product_error",
  API_CALL: "api_call",
  WEBHOOK: "webhook"
};

/**
 * Create a log entry
 * @param {Object} logData - Log data
 * @returns {Promise<Object>} - Created log entry
 */
export async function createLog(logData) {
  const docClient = dynamoClient.getDocClient();

  const logEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    level: LOG_LEVELS.INFO,
    ...logData
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: logEntry
    })
  );

  return logEntry;
}

/**
 * Log sync start
 * @param {string} storeId - Store ID
 * @param {string} platform - Platform type
 * @param {number} totalProducts - Total products to sync
 */
export async function logSyncStart(storeId, platform, totalProducts) {
  return createLog({
    type: LOG_TYPES.SYNC_START,
    storeId,
    platform,
    totalProducts,
    message: `Starting sync for ${storeId} (${totalProducts} products)`
  });
}

/**
 * Log sync progress
 * @param {string} storeId - Store ID
 * @param {number} processed - Products processed so far
 * @param {number} total - Total products
 */
export async function logSyncProgress(storeId, processed, total) {
  return createLog({
    type: LOG_TYPES.SYNC_PROGRESS,
    storeId,
    processed,
    total,
    percentage: Math.round((processed / total) * 100),
    message: `Sync progress: ${processed}/${total} (${Math.round((processed / total) * 100)}%)`
  });
}

/**
 * Log sync completion
 * @param {string} storeId - Store ID
 * @param {number} totalProcessed - Total products processed
 * @param {number} duration - Duration in milliseconds
 * @param {Object} stats - Additional stats (costs, errors, etc.)
 */
export async function logSyncComplete(storeId, totalProcessed, duration, stats = {}) {
  return createLog({
    type: LOG_TYPES.SYNC_COMPLETE,
    storeId,
    totalProcessed,
    duration,
    durationFormatted: formatDuration(duration),
    stats,
    message: `Sync completed for ${storeId}: ${totalProcessed} products in ${formatDuration(duration)}`
  });
}

/**
 * Log sync error
 * @param {string} storeId - Store ID
 * @param {Error} error - Error object
 * @param {Object} context - Additional context
 */
export async function logSyncError(storeId, error, context = {}) {
  return createLog({
    type: LOG_TYPES.SYNC_ERROR,
    level: LOG_LEVELS.ERROR,
    storeId,
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name
    },
    context,
    message: `Sync error for ${storeId}: ${error.message}`
  });
}

/**
 * Log product processing error
 * @param {string} storeId - Store ID
 * @param {string} productId - Product ID
 * @param {Error} error - Error object
 */
export async function logProductError(storeId, productId, error) {
  return createLog({
    type: LOG_TYPES.PRODUCT_ERROR,
    level: LOG_LEVELS.ERROR,
    storeId,
    productId,
    error: {
      message: error.message,
      stack: error.stack
    },
    message: `Product error ${productId}: ${error.message}`
  });
}

/**
 * Get logs for a store
 * @param {string} storeId - Store ID
 * @param {Object} options - { limit, types }
 * @returns {Promise<Array>} - Log entries
 */
export async function getLogsByStore(storeId, options = {}) {
  const { limit = 100, types } = options;
  const docClient = dynamoClient.getDocClient();

  let filterExpression = "storeId = :storeId";
  const expressionValues = { ":storeId": storeId };

  if (types && types.length > 0) {
    filterExpression += " AND #type IN (" + types.map((_, i) => `:type${i}`).join(", ") + ")";
    types.forEach((type, i) => {
      expressionValues[`:type${i}`] = type;
    });
  }

  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionValues,
      ExpressionAttributeNames: types ? { "#type": "type" } : undefined,
      Limit: limit
    })
  );

  // Sort by timestamp descending
  return (result.Items || []).sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );
}

/**
 * Format duration in human readable format
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Save crawler log entry
 * @param {Object} logData - Log data with shopName, appName, startTime, endTime, duration, status, type, additionalInfo
 * @param {string} region - AWS region
 * @returns {Promise<Object>} - DynamoDB put result
 */
export async function saveCrawlerLog(logData, region = "us-east-1") {
  const docClient = dynamoClient.getDocClient();

  const timestamp = Date.now(); // numeric timestamp in milliseconds

  const item = {
    id: uuidv4(),
    createdAt: timestamp,
    shop: logData.shopName,
    appName: logData.appName,
    startTime: logData.startTime,
    endTime: logData.endTime,
    duration: logData.duration,
    status: logData.status || "success",
    type: logData.type || "crawler_activity",
    ...logData.additionalInfo
  };

  return docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    })
  );
}

export default {
  LOG_LEVELS,
  LOG_TYPES,
  createLog,
  logSyncStart,
  logSyncProgress,
  logSyncComplete,
  logSyncError,
  logProductError,
  getLogsByStore,
  saveCrawlerLog
};
