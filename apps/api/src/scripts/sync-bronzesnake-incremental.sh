#!/bin/bash
set -e

# ──────────────────────────────────────────────────────────────────────
# Bronze Snake INCREMENTAL sync — the fast, low-latency companion to the
# full nightly (sync-bronzesnake-all.sh). Meant to run every ~10-15 min via
# cron so a newly-published product gets its bundles within minutes instead
# of waiting up to 24h for the nightly.
#
# Differences from the nightly:
#   • Step 1 uses --since (a short window) so it only fetches products
#     CHANGED recently (published / edited / restocked). updated_at is bumped
#     on publish and on inventory change, so this catches new arrivals AND
#     keeps p.inStock fresh between nightlies.
#   • Footwear classification runs with --missing (only NEW shoes get the
#     Gemini call — cheap enough for a frequent job). Colourways + sale are
#     no-AI and run in full (cheap, keeps flags correct for the new items).
#   • Widget + metafield steps are --missing, so they only touch products
#     that don't have the widget yet → near-zero work when nothing was
#     published.
#   • NO cleanup step. The cleanup deletes "products not seen this sync", but
#     a --since run only stamps the few recent products, so EVERY other
#     product would look stale. Pruning belongs ONLY in the full nightly.
#
# WINDOW vs CADENCE: run every N minutes, look back ~1.5-2x N (overlap), so a
# boundary product or a slow/failed cycle never falls through a gap. The
# overlap re-touches a handful of already-done products, but --missing makes
# that a cheap no-op. Default SINCE=25m (good for a 15-min cron).
#
# Crontab example (every 15 min):
#   */15 * * * * /path/to/repo/apps/api/src/scripts/sync-bronzesnake-incremental.sh >> /path/to/repo/logs/cron-incremental.log 2>&1
# ──────────────────────────────────────────────────────────────────────

# Conda activation — only on EC2 where the env exists (skipped on local).
if [ -f /home/ec2-user/miniconda3/etc/profile.d/conda.sh ]; then
  source /home/ec2-user/miniconda3/etc/profile.d/conda.sh
  conda activate myenv
fi

# Resolve repo root: 4 levels up from this script (apps/api/src/scripts/…).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
cd "$REPO_DIR"

SHOP_DOMAIN="${SHOP_DOMAIN:-bronze-snake-1.myshopify.com}"
# Look-back window for the index step. Make it LARGER than the cron interval
# so consecutive runs overlap (self-healing). Override with SINCE=… or arg 1.
SINCE="${1:-${SINCE:-25m}}"
LOG_FILE="${LOG_FILE:-$REPO_DIR/logs/sync-bronzesnake-incremental-$(date +%Y-%m-%d).log}"
mkdir -p "$(dirname "$LOG_FILE")"

# ── Single-run lock ───────────────────────────────────────────────────
# If a previous cycle is still running (e.g. several products published at
# once → slow AI generation), skip this one instead of piling up overlapping
# runs. Everything is --missing/idempotent, so skipping is safe — the next
# cycle picks up where this left off. (flock is Linux/EC2; harmless no-op
# locally if flock is unavailable — see the fallback.)
LOCK_FILE="${LOCK_FILE:-/tmp/sync-bronzesnake-incremental.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[$(date)] Another incremental run is active — skipping this cycle." | tee -a "$LOG_FILE"
    exit 0
  fi
fi

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Bronze Snake INCREMENTAL sync — $(date)" | tee -a "$LOG_FILE"
echo "  Shop: $SHOP_DOMAIN   Window: --since $SINCE   (no cleanup)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[1/11] Indexing products changed in the last $SINCE (active + published)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js shopify "$SHOP_DOMAIN" --since "$SINCE" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[2/11] Completing colourway groups (Neo4j only; no AI)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/close-colourway-groups.js --shop "$SHOP_DOMAIN" --apply 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[3/11] Flagging SALE / Coming Soon from collection membership (no AI)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/backfill-bronzesnake-sale.js --apply 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[4/11] Classifying NEW footwear → 'boots' (Gemini vision, --missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/backfill-bronzesnake-footwear.js --apply --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[5/11] Generating Complete The Look widgets (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[6/11] Generating Similar Products widgets (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[7/11] Generating Ask AI Options chips (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-ask-ai-options.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[8/11] Writing runa.complete_the_look metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-ctl-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[9/11] Writing runa.similar_products metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-similar-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[10/11] Writing runa.ask_ai_options metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-ask-ai-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[11/11] Writing runa.hero_image metafield (missing only)..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-bronzesnake-hero-image-metafields.js "$SHOP_DOMAIN" --missing --concurrency 5 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Bronze Snake incremental sync completed — $(date)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
