#!/usr/bin/env node

/**
 * CLI script to sync a shop
 *
 * Usage:
 *   node scripts/sync-shop.js --platform shopify --shop mystore.myshopify.com --token shpat_xxx
 *
 * Options:
 *   --platform     Platform type: shopify, woocommerce, vtex (default: shopify)
 *   --shop         Shop domain (required)
 *   --token        Access token (required)
 *   --app-id       Application ID (default: runa)
 *   --app-name     Application name (default: Runa)
 *   --region       AWS region (default: us-east-1)
 *   --no-embeddings  Skip embedding generation
 *   --no-classify    Skip AI classification
 *   --upload-images  Upload images to S3
 */

import { program } from "commander";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

import { ShopifyAdapter } from "@runa/adapters";
import { SyncPipeline, neo4jClient } from "@runa/core";

// Parse command line arguments
program
  .name("sync-shop")
  .description("Sync products from an e-commerce store")
  .requiredOption("--shop <domain>", "Shop domain (e.g., mystore.myshopify.com)")
  .requiredOption("--token <token>", "Access token for the platform API")
  .option("--platform <type>", "Platform type: shopify, woocommerce, vtex", "shopify")
  .option("--app-id <id>", "Application ID", "runa")
  .option("--app-name <name>", "Application name", "Runa")
  .option("--region <region>", "AWS region", "us-east-1")
  .option("--no-embeddings", "Skip embedding generation")
  .option("--no-classify", "Skip AI classification")
  .option("--upload-images", "Upload images to S3")
  .parse();

const opts = program.opts();

/**
 * Create platform adapter based on platform type
 */
function createAdapter(platform, shop, token) {
  switch (platform.toLowerCase()) {
    case "shopify":
      return new ShopifyAdapter(shop, token);

    case "woocommerce":
      console.error("WooCommerce adapter not yet implemented");
      process.exit(1);
      break;

    case "vtex":
      console.error("VTEX adapter not yet implemented");
      process.exit(1);
      break;

    default:
      console.error(`Unknown platform: ${platform}`);
      process.exit(1);
  }
}

/**
 * Main sync function
 */
async function main() {
  console.log("=".repeat(60));
  console.log("  RUNA ADMIN - Shop Sync");
  console.log("=".repeat(60));
  console.log();
  console.log(`Platform:    ${opts.platform}`);
  console.log(`Shop:        ${opts.shop}`);
  console.log(`App ID:      ${opts.appId}`);
  console.log(`Region:      ${opts.region}`);
  console.log(`Embeddings:  ${opts.embeddings !== false ? "Yes" : "No"}`);
  console.log(`Classify:    ${opts.classify !== false ? "Yes" : "No"}`);
  console.log(`Upload imgs: ${opts.uploadImages ? "Yes" : "No"}`);
  console.log();

  try {
    // Create adapter
    const adapter = createAdapter(opts.platform, opts.shop, opts.token);

    // Create pipeline
    const pipeline = new SyncPipeline({
      appId: opts.appId,
      appName: opts.appName,
      region: opts.region
    });

    // Progress callback
    const onProgress = (processed, total) => {
      const percentage = Math.round((processed / total) * 100);
      process.stdout.write(`\rProgress: ${processed}/${total} (${percentage}%)`);
    };

    // Run sync
    const result = await pipeline.syncStore(adapter, {
      generateEmbeddings: opts.embeddings !== false,
      classifyProducts: opts.classify !== false,
      uploadImages: opts.uploadImages,
      onProgress
    });

    console.log("\n");

    if (result.success) {
      console.log("=".repeat(60));
      console.log("  SYNC COMPLETED SUCCESSFULLY");
      console.log("=".repeat(60));
      console.log(`Products processed: ${result.processedCount}`);
      console.log(`Errors:            ${result.errorCount}`);
      console.log(`Duration:          ${Math.round(result.duration / 1000)}s`);
      console.log(`Total cost:        $${result.costs.costs.total.toFixed(4)}`);

      if (result.errors.length > 0) {
        console.log("\nErrors:");
        result.errors.slice(0, 10).forEach((e) => {
          console.log(`  - Product ${e.productId}: ${e.error}`);
        });
        if (result.errors.length > 10) {
          console.log(`  ... and ${result.errors.length - 10} more`);
        }
      }
    } else {
      console.log("=".repeat(60));
      console.log("  SYNC FAILED");
      console.log("=".repeat(60));
      console.log(`Error: ${result.error}`);
    }

  } catch (error) {
    console.error("\nFatal error:", error);
    process.exit(1);
  } finally {
    // Clean up
    await neo4jClient.close();
    process.exit(0);
  }
}

// Run
main();
