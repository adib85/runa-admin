import Pubnub from "pubnub";
import config from "@runa/config";

/**
 * PubNub service for real-time messaging
 * Used for broadcasting sync progress and status updates
 */

let pubnubClient = null;

function getPubnub() {
  if (!pubnubClient) {
    pubnubClient = new Pubnub({
      publishKey: config.pubnub.publishKey,
      subscribeKey: config.pubnub.subscribeKey,
      uuid: config.pubnub.uuid,
      autoNetworkDetection: true,
      restore: true
    });
  }
  return pubnubClient;
}

/**
 * Publish a message to a channel
 * @param {string} channel - Channel name
 * @param {Object} message - Message object
 * @returns {Promise<Object>} - Publish result
 */
export async function publish(channel, message) {
  const pubnub = getPubnub();

  try {
    const result = await pubnub.publish({
      channel,
      message
    });
    return result;
  } catch (error) {
    console.error(`PubNub publish error on ${channel}:`, error);
    throw error;
  }
}

/**
 * Subscribe to a channel
 * @param {string} channel - Channel name
 * @param {Function} callback - Message callback
 */
export function subscribe(channel, callback) {
  const pubnub = getPubnub();

  pubnub.addListener({
    message: (event) => {
      if (event.channel === channel) {
        callback(event.message);
      }
    }
  });

  pubnub.subscribe({ channels: [channel] });
}

/**
 * Unsubscribe from a channel
 * @param {string} channel - Channel name
 */
export function unsubscribe(channel) {
  const pubnub = getPubnub();
  pubnub.unsubscribe({ channels: [channel] });
}

/**
 * Broadcast sync progress
 * @param {string} channelId - Channel ID (usually storeId_scan)
 * @param {number} total - Total items
 * @param {number} processed - Processed items
 */
export async function broadcastSyncProgress(channelId, total, processed) {
  return publish(channelId, {
    type: "sync_progress",
    total,
    processed,
    percentage: Math.round((processed / total) * 100),
    timestamp: new Date().toISOString()
  });
}

/**
 * Broadcast sync status change
 * @param {string} channelId - Channel ID
 * @param {string} status - Status: "pending", "inProgress", "done", "error"
 * @param {Object} details - Additional details
 */
export async function broadcastSyncStatus(channelId, status, details = {}) {
  return publish(channelId, {
    type: "sync_status",
    contextFetching: status,
    ...details,
    timestamp: new Date().toISOString()
  });
}

/**
 * Broadcast error
 * @param {string} channelId - Channel ID
 * @param {string} errorMessage - Error message
 */
export async function broadcastError(channelId, errorMessage) {
  return publish(channelId, {
    type: "error",
    error: errorMessage,
    timestamp: new Date().toISOString()
  });
}

/**
 * Create a channel ID for a store sync
 * @param {string} storeId - Store ID
 * @returns {string} - Channel ID
 */
export function getSyncChannelId(storeId) {
  return `${storeId}_scan`;
}

/**
 * SyncBroadcaster class for convenient progress broadcasting
 */
export class SyncBroadcaster {
  constructor(storeId) {
    this.storeId = storeId;
    this.channelId = getSyncChannelId(storeId);
    this.total = 0;
    this.processed = 0;
  }

  /**
   * Set total items
   */
  setTotal(total) {
    this.total = total;
  }

  /**
   * Update progress and broadcast
   */
  async updateProgress(processed) {
    this.processed = processed;
    await broadcastSyncProgress(this.channelId, this.total, this.processed);
  }

  /**
   * Increment progress
   */
  async incrementProgress(amount = 1) {
    this.processed += amount;
    await broadcastSyncProgress(this.channelId, this.total, this.processed);
  }

  /**
   * Broadcast status change
   */
  async setStatus(status, details = {}) {
    await broadcastSyncStatus(this.channelId, status, details);
  }

  /**
   * Broadcast start
   */
  async start() {
    await this.setStatus("inProgress");
  }

  /**
   * Broadcast completion
   */
  async complete(details = {}) {
    await this.setStatus("done", details);
  }

  /**
   * Broadcast error
   */
  async error(errorMessage) {
    await broadcastError(this.channelId, errorMessage);
    await this.setStatus("error", { error: errorMessage });
  }
}

export default {
  publish,
  subscribe,
  unsubscribe,
  broadcastSyncProgress,
  broadcastSyncStatus,
  broadcastError,
  getSyncChannelId,
  SyncBroadcaster
};
