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

# Serialize against the 15-min incremental sync via a SHARED lock. Without this, an
# incremental cycle could fire between this run's Step 1 and the Step 1.8 cleanup, stamp a
# few products with a newer lastSeenAt, and shift the cleanup's max(lastSeenAt) reference —
# making every product this run just stamped look "stale" (the 10% guard would then abort
# cleanup). Blocking flock: wait for any in-flight incremental to finish, then hold the lock
# for the whole nightly so incrementals fired during it skip (their non-blocking flock fails).
LOCK_FILE="${LOCK_FILE:-/tmp/sync-bronzesnake-incremental.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock 9
fi

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
echo "[Step 1.6/8] Flagging SALE / Coming Soon from collection membership (Bronze Snake only — no Shopify writes)..." | tee -a "$LOG_FILE"
# Step 1 recomputes p.onSale from compare_at_price every run. Bronze Snake's sale
# is the curated womenssale/menssale collections (marked-down price, NO compare-at),
# so that yields ~0. This step reads SALE-collection membership from Shopify and
# sets p.onSale (+ p.comingSoon) accordingly — both directions, so items that left
# the sale are cleared. Reads Shopify (collection lists) and writes ONLY Neo4j.
# Must run AFTER Step 1 so it isn't overwritten. Self-healing: re-runs every night.
node apps/api/src/scripts/backfill-bronzesnake-sale.js --apply 2>&1 | tee -a "$LOG_FILE"

echo ""
# The title/style taxonomy only has heels/sandals/shoes, so boots aren't searchable as a category.
# This pass reads each footwear product's IMAGE + title + description and tags the boots — catching
# mislabels the title misses (e.g. "Corbin Heel" is actually a knee-high boot). Reads product images
# (public CDN) + writes ONLY Neo4j (the `boots` category). Must run AFTER Step 1.
#
# COST CONTROL: this is the only Gemini-vision pass in the nightly. Running it FULL every night
# re-classifies every shoe — pure waste, since a boot stays a boot. So we run --missing (only NEW,
# never-classified footwear → cheap) on most days, and a FULL re-check once a week (Sunday) to
# self-heal any drift / past misclassification. date +%u: 1=Mon … 7=Sun.
if [ "$(date +%u)" = "7" ]; then
  FOOTWEAR_MODE="(weekly FULL re-check)"; FOOTWEAR_FLAGS="--apply"
else
  FOOTWEAR_MODE="(--missing: new footwear only)"; FOOTWEAR_FLAGS="--apply --missing"
fi
echo "[Step 1.7/8] Classifying footwear → 'boots' $FOOTWEAR_MODE..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/backfill-bronzesnake-footwear.js $FOOTWEAR_FLAGS 2>&1 | tee -a "$LOG_FILE"

# ──────────────────────────────────────────────────────────────────────
# Prune products that genuinely LEFT the catalogue (no longer in /collections/all,
# so not p.lastSeenAt-stamped this run). NOTE: out-of-stock products are NOT pruned
# here — Bronze Snake keeps sold-out items in /collections/all, so they're still
# stamped and KEPT in the index (they need to keep their own Complete-the-Look /
# Similar widgets, incl. coming-soon products). OOS products are instead excluded
# from chat + widget *candidates* by the p.inStock flag (written fresh every sync
# from real inventory) via `coalesce(p.inStock, true) = true` in the serverless
# handlers. So this step only removes truly-removed products.
#
# --grace-days 0: remove as soon as a product leaves /collections/all (prompt, so a
# removed product with a stale inStock=true can't linger as a candidate). Hard delete
# (DETACH DELETE) + orphan-variant cleanup, scoped to this store. Never touches
# Shopify or the widget caches. Guards: aborts if the last sync didn't complete within
# 4h, and if it would delete >10% of the catalogue (catches a partial sync). `|| true`
# keeps a safety-abort from failing the whole nightly run.
# Preview:  node apps/api/src/scripts/sync-cleanup-stale.js "$SHOP_DOMAIN" --grace-days 0 --dry-run
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "[Step 1.8/8] Pruning removed products from Neo4j (kept: out-of-stock; filtered via inStock)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-cleanup-stale.js "$SHOP_DOMAIN" --grace-days 0 2>&1 | tee -a "$LOG_FILE" || true

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

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Bronze Snake Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
