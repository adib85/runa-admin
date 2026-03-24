#!/usr/bin/env node

/**
 * Modular Sync CLI Script
 * Uses the new modular architecture with provider support
 * 
 * Usage:
 *   # Shopify
 *   node apps/api/src/scripts/sync-modular.js shopify my-store.myshopify.com shpat_xxx
 *   node apps/api/src/scripts/sync-modular.js shopify my-store.myshopify.com shpat_xxx --force
 *   node apps/api/src/scripts/sync-modular.js shopify my-store.myshopify.com shpat_xxx --demographic woman
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
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootEnv = path.resolve(__dirname, "../../../../.env");
dotenv.config({ path: rootEnv });

import fetch from "node-fetch";
import { SyncOrchestrator } from "../sync/index.js";

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

async function fetchAccessTokenFromDB(shopDomain) {
  const url = `${APP_SERVER_URL}?action=getUser&shop=${shopDomain}`;
  const response = await fetch(url);
  const data = await response.json();
  const token = data?.data?.accessToken;
  if (!token) {
    throw new Error(`No accessToken found in database for shop "${shopDomain}"`);
  }
  console.log(`  Access token fetched from database for ${shopDomain}`);
  return token;
}

async function main() {
  const args = process.argv.slice(2);
  const forceAll = args.includes('--force') || args.includes('-f');
  const rewriteDescriptions = args.includes('--rewrite-descriptions');

  const demoIdx = args.indexOf('--demographic');
  const demographic = demoIdx !== -1 ? args[demoIdx + 1] : null;

  const modelIdx = args.indexOf('--gemini-model');
  const geminiModel = modelIdx !== -1 ? args[modelIdx + 1] : null;

  const flagsWithValues = ['--demographic', '--gemini-model'];
  const filteredArgs = args.filter((a, i) => !a.startsWith('-') && !flagsWithValues.includes(args[i - 1]));
  
  const provider = filteredArgs[0] || 'shopify';
  
  let config = {
    provider,
    forceAll,
    rewriteDescriptions,
    demographic,
    geminiModel,
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
    let accessToken = filteredArgs[2] || process.env.ACCESS_TOKEN;

    if (!shopName) {
      console.error(`
Usage: node sync-modular.js <provider> <shop-domain> [access-token] [--force] [--demographic <value>]

Arguments:
  provider      The e-commerce platform (shopify, vtex, woocommerce, vrex)
  shop-domain   The store domain
  access-token  The API access token (optional — auto-fetched from database if omitted)

Options:
  --force, -f              Process ALL products (skip existing product check)
  --demographic <value>    Default demographic for products (woman, man, unisex). Defaults to "woman"
  --rewrite-descriptions   Regenerate AI descriptions for ALL products (even those with existing descriptions)

Examples:
  node sync-modular.js shopify my-store.myshopify.com
  node sync-modular.js shopify my-store.myshopify.com --force
  node sync-modular.js shopify my-store.myshopify.com --demographic unisex
  node sync-modular.js shopify my-store.myshopify.com --force --rewrite-descriptions
      `);
      process.exit(1);
    }

    if (!accessToken) {
      accessToken = await fetchAccessTokenFromDB(shopName);
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
