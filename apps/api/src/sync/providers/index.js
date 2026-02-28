/**
 * Providers Index
 * Export all provider implementations
 */

import { BaseProvider } from "./base.js";
import { ShopifyProvider } from "./shopify.js";
import { WooCommerceProvider } from "./woocommerce.js";
import { VrexProvider } from "./vrex.js";
import { VtexProvider } from "./vtex.js";

export { BaseProvider, ShopifyProvider, WooCommerceProvider, VrexProvider, VtexProvider };

/**
 * Get provider class by type
 */
export function getProviderClass(providerType) {
  const providers = {
    shopify: ShopifyProvider,
    woocommerce: WooCommerceProvider,
    vrex: VrexProvider,
    vtex: VtexProvider
  };
  
  const Provider = providers[providerType.toLowerCase()];
  if (!Provider) {
    throw new Error(`Unknown provider type: ${providerType}`);
  }
  return Provider;
}
