#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# XPERT BEAUTY — catalog sync from the merchant's Meta feed (xpertbeauty.ro)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Source: the public Facebook/Meta catalog CSV the merchant regenerates ~2x/day
#   https://conf.xpertbeauty.ro/tools/product_feeds/facebook_feed_1.csv
# The provider downloads it (atomic write, keeps .prev) and REFUSES a truncated feed
# (< 1 MB, bad header, or < 80% of the previous row count) — falling back to the last
# good copy — so a broken feed can never drive the stale-prune.
#
# Run this ~30 min after each of the merchant's generation times (2x/day).
#   BaseProvider.stampSeen() refreshes price + inStock on EVERY product each run without
#   re-embedding; only NEW products get the AI + embedding pass. Weekly (Sunday) --force
#   re-embeds everything to self-heal title/description/category drift.
#
# Usage:
#   bash apps/api/src/scripts/sync-xpertbeauty-all.sh            # incremental (weekly --force on Sunday)
#   FORCE=1 bash apps/api/src/scripts/sync-xpertbeauty-all.sh    # full re-embed now
#   SKIP_CLEANUP=1 bash apps/api/src/scripts/sync-xpertbeauty-all.sh
#   SKIP_ENRICH=1 / REENRICH=1                                   # skip / redo the GraphQL enrichment step
#   SKIP_GRAPHQL_ENRICH=1                                         # skip only the store GraphQL call (keeps the profile scoring of new products)
#   NO_WEEKLY_FORCE=1                                             # no automatic full re-embed on Sundays
#   PREBUILD=1                                                    # step 5: build what is missing or outdated (rituals, questions,
#                                                                 #   personalised rituals of general products) — see prebuild-xpertbeauty-rituals.mjs
#   SKIP_TYPES=1                                                  # skip step 4b (Runa product types for new products)
#   SKIP_STALE_RITUALS=1                                          # skip step 6 (daily refresh of rituals with OOS/removed products)
#   FEED=/path/or/url bash ...                                    # override the feed source
#
# Crontab (EC2, Europe/Bucharest) — adjust to ~30 min after their generation times:
# The Xpert sync lives in its OWN folder on the server (~/runa-admin-xpert, a copy of the files this sync needs), so
# it never shares code with the Quicklly / Toff / Amalin syncs in ~/runa-admin. Stock + prices only: no ritual building.
#   50 10 * * * SKIP_STALE_RITUALS=1 SKIP_GRAPHQL_ENRICH=1 NO_WEEKLY_FORCE=1 bash /home/ec2-user/runa-admin-xpert/apps/api/src/scripts/sync-xpertbeauty-all.sh >> /home/ec2-user/runa-admin-xpert/logs/cron-xpertbeauty.log 2>&1
#   50 22 * * * SKIP_STALE_RITUALS=1 SKIP_GRAPHQL_ENRICH=1 NO_WEEKLY_FORCE=1 bash /home/ec2-user/runa-admin-xpert/apps/api/src/scripts/sync-xpertbeauty-all.sh >> /home/ec2-user/runa-admin-xpert/logs/cron-xpertbeauty.log 2>&1
#   30 1  * * * cd /home/ec2-user/runa-admin/apps/api && flock -n /tmp/xb-prebuild.lock /home/ec2-user/miniconda3/envs/myenv/bin/node src/scripts/prebuild-xpertbeauty-rituals.mjs --concurrency 6 --max-minutes 300 >> /home/ec2-user/runa-admin/logs/cron-xpertbeauty-prebuild.log 2>&1
#       ↑ the nightly pre-build (its own cron line, after the evening sync): everything shoppers can see is built ahead of time
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

if [ -f /home/ec2-user/miniconda3/etc/profile.d/conda.sh ]; then
  source /home/ec2-user/miniconda3/etc/profile.d/conda.sh
  conda activate myenv 2>/dev/null || true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
cd "$REPO_DIR"

STORE_ID="xpertbeauty.ro"
FEED="${FEED:-}"   # empty → provider default (live feed URL)
LOG_FILE="${LOG_FILE:-$REPO_DIR/logs/sync-xpertbeauty-$(date +%Y-%m-%d_%H%M).log}"
mkdir -p "$(dirname "$LOG_FILE")"

export SYNC_FETCH_BATCH="${SYNC_FETCH_BATCH:-48}"
export SYNC_CONCURRENCY="${SYNC_CONCURRENCY:-24}"
export SYNC_FAST_INDEX="${SYNC_FAST_INDEX:-true}"

# Never overlap two runs (2x/day schedule + a slow weekly --force could collide).
LOCK_FILE="${LOCK_FILE:-/tmp/sync-xpertbeauty.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[$(date +%H:%M:%S)] Another Xpert Beauty sync is running — exiting." | tee -a "$LOG_FILE"
    exit 0
  fi
fi

if [ "${FORCE:-0}" = "1" ] || { [ "$(date +%u)" = "7" ] && [ "${NO_WEEKLY_FORCE:-0}" != "1" ]; }; then
  FORCE_FLAG="--force"; MODE="FULL (--force: re-embed every product)"
else
  FORCE_FLAG="";       MODE="incremental (new products embedded; price/stock stamped on all)"
fi

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Xpert Beauty Sync — $(date)"                              | tee -a "$LOG_FILE"
echo "  Store: $STORE_ID   Feed: ${FEED:-<live feed URL>}"        | tee -a "$LOG_FILE"
echo "  Mode:  $MODE"                                              | tee -a "$LOG_FILE"
echo "  Batch: $SYNC_FETCH_BATCH  Concurrency: $SYNC_CONCURRENCY" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "[Step 1/4] Syncing catalog from the Meta feed to Neo4j..." | tee -a "$LOG_FILE"
if ! node apps/api/src/scripts/sync-modular.js xpertbeauty $FEED $FORCE_FLAG 2>&1 | tee -a "$LOG_FILE"; then
  echo "✗ Sync step failed — skipping cleanup (a partial sync must never drive the prune)." | tee -a "$LOG_FILE"
  exit 1
fi

# Prune products that genuinely LEFT the feed. Out-of-stock products are KEPT (indexed,
# excluded as chat candidates via coalesce(p.inStock,true)). --grace-days 3 rides out a
# missed/short feed; the built-in >10% guard aborts on a partial sync.
if [ "${SKIP_CLEANUP:-0}" != "1" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 2/4] Pruning removed products from Neo4j (out-of-stock are KEPT)..." | tee -a "$LOG_FILE"
  node apps/api/src/scripts/sync-cleanup-stale.js "$STORE_ID" --grace-days 3 2>&1 | tee -a "$LOG_FILE" || true
else
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 2/4] SKIP_CLEANUP=1 — stale prune skipped." | tee -a "$LOG_FILE"
fi

# ── Enrichment + profiles for NEW products only (public GraphQL, then one cheap LLM call per product).
# Both are idempotent: enrichment keys on p.enrichedAt, profiles on p.profileScoredAt. The weekly --force
# run does NOT re-enrich (static attributes don't drift); pass REENRICH=1 to redo everything.
if [ "${SKIP_ENRICH:-0}" != "1" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 3/6] Enriching new products from the public GraphQL (size, line, categories, bundles)..." | tee -a "$LOG_FILE"
  if [ "${SKIP_GRAPHQL_ENRICH:-0}" = "1" ]; then
    echo "  SKIP_GRAPHQL_ENRICH=1 — store GraphQL enrichment skipped (the store's protection refuses it since 2026-11)." | tee -a "$LOG_FILE"
  else
    if [ "${REENRICH:-0}" = "1" ]; then EMODE="--all"; else EMODE="--new"; fi
    (cd apps/api && node src/scripts/enrich-xpertbeauty-graphql.mjs $EMODE) 2>&1 | tee -a "$LOG_FILE" || true
  fi
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 4/6] Profile affinities for new products (HairType/SkinType, SUITABLE_FOR) + review CSVs..." | tee -a "$LOG_FILE"
  (cd apps/api && PROFILE_CONCURRENCY=6 node src/scripts/extract-xpertbeauty-profiles.mjs) 2>&1 | tee -a "$LOG_FILE" || true
fi

# ── Step 4b: Runa product type for new products (rules + Gemini 3.8 Flash check; cents per day). SKIP_TYPES=1 skips it.
if [ "${SKIP_TYPES:-0}" != "1" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 4b] Runa product types for new products (rules + AI)..." | tee -a "$LOG_FILE"
  (cd apps/api && node src/scripts/type-xpertbeauty-products.mjs) 2>&1 | tee -a "$LOG_FILE" || true
fi

# ── Step 5 (optional, PREBUILD=1 or the old WARM=1): build what is missing or outdated right after this sync — default
# rituals + questions for every in-stock product, personalised rituals for the general products. Normally this runs
# from its own nightly cron line (see the header); here it is for a manual run.
if [ "${PREBUILD:-${WARM:-0}}" = "1" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 5/6] Pre-building rituals + questions (new, prompt changed, aged)..." | tee -a "$LOG_FILE"
  (cd apps/api && XB_CF_DISTRIBUTION="${XB_CF_DISTRIBUTION:-E1M8L85URRPIX9}" node src/scripts/prebuild-xpertbeauty-rituals.mjs --concurrency 6 --max-minutes 300) 2>&1 | tee -a "$LOG_FILE" || true
fi

# ── Step 6: recompute cached rituals that contain a product that just went out of stock / left the catalog
# (runs after the stock stamp + prune of this very run, so it sees today's changes). Cheap: only affected heroes.
if [ "${SKIP_STALE_RITUALS:-0}" != "1" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 6/6] Refreshing rituals that contain out-of-stock / removed products..." | tee -a "$LOG_FILE"
  (cd apps/api && node src/scripts/refresh-xpertbeauty-stale-rituals.mjs --concurrency 3) 2>&1 | tee -a "$LOG_FILE" || true
fi

# ── Step 7: clear the data CDN, so product pages show the prices and stock this sync just wrote. Browsers keep none of our
# answers since 2026-11-17 (like Amazon); the CDN keeps each one 12 h, so this clear reaches every shopper on their next
# page view. One path per run ("/*"), free up to 1,000 a month. SKIP_CDN_CLEAR=1 skips it.
if [ "${SKIP_CDN_CLEAR:-0}" != "1" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "[Step 7] Clearing the data CDN (${XB_CF_DISTRIBUTION:-E1M8L85URRPIX9}) — pages show the new prices and stock..." | tee -a "$LOG_FILE"
  if INV=$(aws cloudfront create-invalidation --distribution-id "${XB_CF_DISTRIBUTION:-E1M8L85URRPIX9}" --paths "/*" --query 'Invalidation.Id' --output text 2>&1); then
    echo "  data CDN cleared (invalidation $INV)" | tee -a "$LOG_FILE"
  else
    echo "  ⚠ could not clear the data CDN: $INV" | tee -a "$LOG_FILE"
  fi
fi

echo "" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Xpert Beauty Sync completed — $(date)"                    | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE"                                            | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
