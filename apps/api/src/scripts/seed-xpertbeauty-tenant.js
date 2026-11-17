#!/usr/bin/env node

/**
 * Seed the Xpert Beauty tenant record into the DynamoDB UserTable.
 *
 * Every client needs a UserTable row (keyed by `id`, looked up by the `shop_index`
 * GSI on `shop`) so the sync pipeline's processContext() can persist AI suggestions
 * and the chat/widget frontend can serve the store. This creates a MINIMAL record
 * mirroring an existing tenant (e.g. carrefour_hipermarket) — the `context`
 * (categories + suggestions) is filled in automatically at the end of the first sync.
 *
 * Idempotent: if a record for shop "xpertbeauty.ro" already exists it is left
 * untouched (use --force to overwrite the scalar fields).
 *
 * Usage:
 *   node apps/api/src/scripts/seed-xpertbeauty-tenant.js --dry-run
 *   node apps/api/src/scripts/seed-xpertbeauty-tenant.js
 *   node apps/api/src/scripts/seed-xpertbeauty-tenant.js --force
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const { default: dynamodb } = await import("../sync/services/dynamodb.js");

const SHOP = "xpertbeauty.ro";
const REGION = "us-east-1";

const RECORD = {
  id: "offline_xpertbeauty",   // primary key (mirrors "offline_carrefour_hipermarket")
  shop: SHOP,                  // shop_index GSI key — what getUserByShop queries
  name: "Xpert Beauty",
  currency: "RON",
  syncInProgress: false,
  syncProgress: 0,
  contextFetching: "pending",  // becomes "done" after the first sync's processContext
  totalMessages: 0,
  chat: {},                    // beauty-assistant prompts land here later (separate work)
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  const existing = await dynamodb.getUserByShop(SHOP, REGION);
  if (existing && !force) {
    console.log(`✓ Tenant already exists for shop "${SHOP}" (id=${existing.id}). Nothing to do.`);
    console.log(`  (re-run with --force to overwrite scalar fields)`);
    process.exit(0);
  }

  if (existing && force) {
    // Preserve everything already there; only refresh the scalar fields we own.
    Object.assign(existing, {
      name: RECORD.name,
      currency: RECORD.currency,
    });
    console.log(`Overwriting scalar fields on existing tenant id=${existing.id}`);
    if (dryRun) { console.log("[dry-run] would save:", JSON.stringify(existing)); process.exit(0); }
    await dynamodb.saveUser(existing, REGION);
    console.log(`✓ Updated tenant for "${SHOP}".`);
    process.exit(0);
  }

  console.log("Creating new tenant record:");
  console.log(JSON.stringify(RECORD, null, 2));
  if (dryRun) { console.log("[dry-run] nothing written."); process.exit(0); }

  await dynamodb.saveUser(RECORD, REGION);
  const verify = await dynamodb.getUserByShop(SHOP, REGION);
  if (verify) console.log(`✓ Created tenant for "${SHOP}" (id=${verify.id}).`);
  else console.error(`✗ Wrote record but getUserByShop("${SHOP}") returned null — check the shop_index GSI.`);
  process.exit(0);
}

main().catch((e) => { console.error("Seed failed:", e); process.exit(1); });
