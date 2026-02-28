#!/usr/bin/env node

/**
 * Modular Sync CLI Script
 * Uses the new modular architecture with provider support
 * 
 * Usage:
 *   # Shopify
 *   node apps/api/src/scripts/sync-modular.js shopify my-store.myshopify.com shpat_xxx
 *   node apps/api/src/scripts/sync-modular.js shopify my-store.myshopify.com shpat_xxx --force
 *   
 *   # VTEX (requires appKey and appToken)
 *   node apps/api/src/scripts/sync-modular.js vtex accountName appKey appToken
 *   node apps/api/src/scripts/sync-modular.js vtex accountName appKey appToken --force
 *   
 * Supported providers:
 *   - shopify
 *   - vtex
 *   - woocommerce (coming soon)
 *   - vrex (coming soon)
 */

import dotenv from "dotenv";
dotenv.config();

import { SyncOrchestrator } from "../sync/index.js";

async function main() {
  const args = process.argv.slice(2);
  const forceAll = args.includes('--force') || args.includes('-f');
  const filteredArgs = args.filter(a => !a.startsWith('-'));
  
  const provider = filteredArgs[0] || 'shopify';
  
  let config = {
    provider,
    forceAll,
    region: "us-east-1"
  };

  // Provider-specific configuration
  if (provider === 'vtex') {
    // VTEX requires: accountName, appKey, appToken
    const accountName = filteredArgs[1] || process.env.VTEX_ACCOUNT_NAME;
    const appKey = filteredArgs[2] || process.env.VTEX_APP_KEY;
    const appToken = filteredArgs[3] || process.env.VTEX_APP_TOKEN;

    if (!accountName || !appKey || !appToken) {
      console.error(`
Usage: node sync-modular.js vtex <account-name> <app-key> <app-token> [--force]

Arguments:
  account-name  The VTEX account name (e.g., "mystore")
  app-key       X-VTEX-API-AppKey value
  app-token     X-VTEX-API-AppToken value

Options:
  --force, -f   Process ALL products (skip existing product check)

Environment variables (alternative):
  VTEX_ACCOUNT_NAME   Account name
  VTEX_APP_KEY        App key
  VTEX_APP_TOKEN      App token

Examples:
  node sync-modular.js vtex mystore vtexappkey-xxxx vtexapptoken-xxxx
  node sync-modular.js vtex mystore vtexappkey-xxxx vtexapptoken-xxxx --force
      `);
      process.exit(1);
    }

    config = {
      ...config,
      accountName,
      shopName: `${accountName}.vtexcommercestable.com.br`,
      appKey,
      appToken,
      channelId: `${accountName}_scan`
    };
  } else {
    // Default: Shopify and other providers
    const shopName = filteredArgs[1] || process.env.SHOP_DOMAIN;
    const accessToken = filteredArgs[2] || process.env.ACCESS_TOKEN;

    if (!shopName || !accessToken) {
      console.error(`
Usage: node sync-modular.js <provider> <shop-domain> <access-token> [--force]

Arguments:
  provider      The e-commerce platform (shopify, vtex, woocommerce, vrex)
  shop-domain   The store domain
  access-token  The API access token

Options:
  --force, -f   Process ALL products (skip existing product check)

Examples:
  node sync-modular.js shopify my-store.myshopify.com shpat_xxx
  node sync-modular.js shopify my-store.myshopify.com shpat_xxx --force
      `);
      process.exit(1);
    }

    config = {
      ...config,
      shopName,
      accessToken,
      channelId: `${shopName}_scan`
    };
  }

  const sync = new SyncOrchestrator(config);
  await sync.run();
  process.exit(0);
}

main().catch(e => {
  console.error("Sync failed:", e);
  process.exit(1);
});
