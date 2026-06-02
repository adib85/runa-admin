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

  // All publishes are fire-and-forget. PubNub v7 publish() returns a promise; an
  // unhandled rejection (e.g. DNS/network failure when the machine sleeps) would
  // otherwise crash the whole sync process — so swallow + log instead.
  _safePublish(payload, label) {
    try {
      const p = this.client.publish(payload);
      if (p && typeof p.catch === "function") {
        p.catch(e => console.log(`  [pubnub] ${label} failed (ignored):`, e?.message || e));
      }
    } catch (e) {
      console.log(`  [pubnub] ${label} threw (ignored):`, e?.message || e);
    }
  }

  publishProgress(channelId, processed, total) {
    this._safePublish({ channel: channelId, message: { total, processed } }, "publishProgress");
  }

  publishContextStatus(channelId, status) {
    this._safePublish({ channel: channelId, message: { contextFetching: status } }, "publishContextStatus");
  }

  publish(channelId, message) {
    this._safePublish({ channel: channelId, message }, "publish");
  }
}

export default new PubNubService();
