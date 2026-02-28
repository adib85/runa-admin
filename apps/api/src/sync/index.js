/**
 * Sync Orchestrator
 * Main entry point for the modular sync architecture
 * 
 * Usage:
 *   import { SyncOrchestrator } from './sync/index.js';
 *   
 *   const sync = new SyncOrchestrator({
 *     provider: 'shopify',
 *     shopName: 'my-store.myshopify.com',
 *     accessToken: 'shpat_xxxxx',
 *     forceAll: false
 *   });
 *   
 *   await sync.run();
 */

import { ShopifyProvider } from "./providers/shopify.js";
import { WooCommerceProvider } from "./providers/woocommerce.js";
import { VrexProvider } from "./providers/vrex.js";
import { VtexProvider } from "./providers/vtex.js";

export class SyncOrchestrator {
  constructor(config) {
    this.config = config;
    this.provider = this.createProvider(config);
  }

  createProvider(config) {
    const providerType = config.provider?.toLowerCase() || 'shopify';
    
    switch (providerType) {
      case 'shopify':
        return new ShopifyProvider(config);
      case 'woocommerce':
        return new WooCommerceProvider(config);
      case 'vrex':
        return new VrexProvider(config);
      case 'vtex':
        return new VtexProvider(config);
      default:
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  async run() {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║   RUNA PRODUCT SYNC - MODULAR ARCHITECTURE                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  Provider: ${this.provider.providerType.padEnd(53)}║
║  Shop: ${this.config.shopName.padEnd(57)}║
║  Mode: ${this.config.forceAll ? 'FORCE (all products)'.padEnd(57) : 'Normal (new products only)'.padEnd(57)}║
╚═══════════════════════════════════════════════════════════════════╝
    `);

    await this.provider.sync();

    console.log("\n✓ Sync completed successfully");
  }
}

// Export everything for modular usage
export * from "./providers/index.js";
export * from "./services/index.js";
export * from "./utils/index.js";

export default SyncOrchestrator;
