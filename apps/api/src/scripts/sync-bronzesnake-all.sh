#!/bin/bash
set -e

# ──────────────────────────────────────────────────────────────────────
# INCREMENTAL by design: every step runs with --missing, so it only
# touches products that haven't been processed yet (no *_updated_at in
# Neo4j for the generate steps, no *_metafield_synced_at for the publish
# steps). It will NOT regenerate caches or rewrite metafields for products
# already done. That makes the nightly run fast and self-healing for new
# arrivals — but it means manual cache edits won't propagate from here.
#
# To rewrite EXISTING products (e.g. after overriding userOptions in the
# cache), run the relevant step manually with --force and WITHOUT --missing:
#   node apps/api/src/scripts/sync-bronzesnake-ask-ai-metafields.js   "$SHOP_DOMAIN" --force --concurrency 5
#   node apps/api/src/scripts/sync-bronzesnake-ctl-metafields.js      "$SHOP_DOMAIN" --force --concurrency 5
#   node apps/api/src/scripts/sync-bronzesnake-similar-metafields.js  "$SHOP_DOMAIN" --force --concurrency 5
#
# Language: the whole pipeline reads/writes the `_en` cache key. The Ask-AI
# and CTL Lambdas default to `ro`, so the live storefront can create a
# separate `_ro` bucket this pipeline never updates — that drift is a
# storefront/theme issue, not fixable from here.
# ──────────────────────────────────────────────────────────────────────

# Conda activation — only on EC2 where the env exists. Skipped silently
# on local machines (Mac, dev box) which use the system Node directly.
if [ -f /home/ec2-user/miniconda3/etc/profile.d/conda.sh ]; then
  source /home/ec2-user/miniconda3/etc/profile.d/conda.sh
  conda activate myenv
fi

# Resolve repo root: 4 levels up from this script (apps/api/src/scripts/…).
# Override with REPO_DIR=… for unusual layouts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
cd "$REPO_DIR"

SHOP_DOMAIN="${SHOP_DOMAIN:-bronze-snake-1.myshopify.com}"
# SHOP_TOKEN intentionally unset: downstream scripts fetch the per-shop
# access token from the Lambda DB (action=getUser). Override by exporting
# SHOP_TOKEN=shpat_... before running this script.
LOG_FILE="${LOG_FILE:-$REPO_DIR/logs/sync-bronzesnake-$(date +%Y-%m-%d_%H%M).log}"
mkdir -p "$(dirname "$LOG_FILE")"

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Bronze Snake Full Sync — $(date)" | tee -a "$LOG_FILE"
echo "  Shop: $SHOP_DOMAIN" | tee -a "$LOG_FILE"
echo "  Window: FULL catalogue (no --since filter — self-healing if a previous run failed)" | tee -a "$LOG_FILE"
echo "  Mode: Steps 1-4 fill DynamoDB cache; Steps 5-8 write runa.* metafields back to Shopify" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[Step 1/8] Syncing ALL products from Shopify to Neo4j (full refresh)..." | tee -a "$LOG_FILE"
# We deliberately don't use --since here. An incremental window (e.g. 26h)
# is faster but would permanently miss products if a previous nightly run
# failed or an update arrived just outside the window. A full sync of
# ~3.5k products takes ~5-10 min and is fully idempotent.
node apps/api/src/scripts/sync-modular.js shopify "$SHOP_DOMAIN" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 1.5/8] Completing colourway groups in Neo4j (Bronze Snake only — no Shopify writes)..." | tee -a "$LOG_FILE"
# Step 1 stores each product's OWN (often partial/asymmetric) custom.related_colourways
# metafield as the node property p.related_colourways. This step unions those into connected
# groups and writes the COMPLETE sibling list + bidirectional edges back to every variant, so
# each colour lists all the others. Reads & writes ONLY Neo4j — never Shopify. Scoped to this
# shop, so the other shops' syncs are unaffected. Self-healing: re-runs cleanly every night.
node apps/api/src/scripts/close-colourway-groups.js --shop "$SHOP_DOMAIN" --apply 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 2/8] Generating Complete The Look widgets (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 3/8] Generating Similar Products widgets (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 4/8] Generating Ask AI Options chips (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-ask-ai-options.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 5/8] Writing runa.complete_the_look metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-ctl-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 6/8] Writing runa.similar_products metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-similar-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 7/8] Writing runa.ask_ai_options metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-ask-ai-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 8/8] Writing runa.hero_image metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-hero-image-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

# ──────────────────────────────────────────────────────────────────────
# Optional cleanup: removes products from Neo4j that are no longer
# visible on bronzesnake.com/collections/all. Disabled by default —
# enable manually when you want to prune. Never touches Shopify.
# ──────────────────────────────────────────────────────────────────────
# echo ""
# echo "[Optional] Pruning Neo4j products no longer visible on storefront..." | tee -a "$LOG_FILE"
# node apps/api/src/scripts/cleanup-bronzesnake-invisible.js 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Bronze Snake Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
