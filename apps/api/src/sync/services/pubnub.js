/**
 * PubNub Service
 * Handles real-time sync progress notifications
 */

import Pubnub from "pubnub";
import { PUBNUB_CONFIG } from "./config.js";

class PubNubService {
  constructor() {
    this.client = new Pubnub(PUBNUB_CONFIG);
  }

  publishProgress(channelId, processed, total) {
    this.client.publish({
      channel: channelId,
      message: { total, processed }
    });
  }

  publishContextStatus(channelId, status) {
    this.client.publish({
      channel: channelId,
      message: { contextFetching: status }
    });
  }

  publish(channelId, message) {
    this.client.publish({ channel: channelId, message });
  }
}

export default new PubNubService();
