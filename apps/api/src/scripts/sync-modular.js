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
  const dryRun = args.includes('--dry-run');
  const rewriteHeroes = args.includes('--rewrite-heroes');

  const demoIdx = args.indexOf('--demographic');
  const demographic = demoIdx !== -1 ? args[demoIdx + 1] : null;

  const modelIdx = args.indexOf('--gemini-model');
  const geminiModel = modelIdx !== -1 ? args[modelIdx + 1] : null;

  const maxIdx = args.indexOf('--max');
  const maxProducts = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : null;

  const sinceIdx = args.indexOf('--since');
  const sinceArg = sinceIdx !== -1 ? args[sinceIdx + 1] : null;
  let sinceIso = null;
  if (sinceArg) {
    const m = sinceArg.match(/^(\d+)([smhd])$/);
    if (!m) {
      console.error("--since must be in form like '70m', '4h', '2d', '300s'");
      process.exit(1);
    }
    const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    sinceIso = new Date(Date.now() - parseInt(m[1], 10) * unitMs[m[2]]).toISOString();
    console.log(`  [Sync] Filtering to products updated since ${sinceIso} (--since ${sinceArg})`);
  }

  const flagsWithValues = ['--demographic', '--gemini-model', '--max', '--since'];
  const filteredArgs = args.filter((a, i) => !a.startsWith('-') && !flagsWithValues.includes(args[i - 1]));
  
  const provider = filteredArgs[0] || 'shopify';
  
  let config = {
    provider,
    forceAll,
    rewriteDescriptions,
    rewriteHeroes,
    demographic,
    geminiModel,
    maxProducts,
    dryRun,
    sinceIso,
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
  --max <n>     Stop after processing N products (useful for test runs)

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
  --max <n>                Stop after processing N products (useful for test runs)
  --since <duration>       Only fetch products updated within the given window (e.g. 70m, 4h, 2d).
                           Append to GraphQL query as updated_at:>=ISO. Big speedup for hourly cron.
  --rewrite-heroes         Recompute the AI-picked hero image for ALL products (Bronze Snake only — gated to
                           the shop opt-in inside ShopifyProvider.shouldPickHero).
  --dry-run                Run the full pipeline (incl. AI) but skip ALL writes to Neo4j, DynamoDB, and PubNub

Examples:
  node sync-modular.js shopify my-store.myshopify.com
  node sync-modular.js shopify my-store.myshopify.com --force
  node sync-modular.js shopify my-store.myshopify.com --demographic unisex
  node sync-modular.js shopify my-store.myshopify.com --force --rewrite-descriptions
  node sync-modular.js shopify my-store.myshopify.com --max 10
  node sync-modular.js shopify my-store.myshopify.com --force --max 2
  node sync-modular.js shopify my-store.myshopify.com --dry-run --max 5
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
