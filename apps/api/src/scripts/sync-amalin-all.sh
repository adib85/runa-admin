#!/bin/bash
# apps/api/src/scripts/sync-amalin-all.sh — cron on EC2 italia, 04:30 Europe/Bucharest (added 2026-10-13).
# Amalin (amalin.com = andreearaicu.myshopify.com) nightly: full product sync + prune what left the shop.
#
#   Step 1  sync-modular.js shopify <shop>   FULL run (never --since: the retire pass in base.js treats a
#           --since window as a "confirmed shrink" and flags the rest of the catalogue inStock=false —
#           that is what hid 2,596 of 3,704 Bronze Snake products in Sept).
#           New products: full AI processing. Every product seen: lastSeenAt, inStock, availableSizes(+Tokens),
#           p.price (min variant price, RON) via stampSeen. Products not seen: inStock=false (retire pass).
#           Sundays (after the parity patch + one-time float-variant cleanup) add --force to refresh
#           variants / en_* / titles / images / embeddings of EXISTING products too (~$0.10, ~15 min).
#   Step 2  sync-cleanup-stale.js --grace-days 0  hard-deletes Store-linked products not stamped by step 1
#           (the PDP "how to style it" Lambda ignores inStock, so delete is the only retirement it sees).
#           NO --require-404: Amalin hides products as UNLISTED (storefront answers 200 + noindex), so a
#           404 gate would keep them. Guards: aborts if step 1 did not finish <4h ago or would delete >10%.
set -euo pipefail

if [ -f /home/ec2-user/miniconda3/etc/profile.d/conda.sh ]; then
  set +u; source /home/ec2-user/miniconda3/etc/profile.d/conda.sh; conda activate myenv; set -u
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
cd "$REPO_DIR"

SHOP_DOMAIN="${SHOP_DOMAIN:-andreearaicu.myshopify.com}"
LOG_FILE="${LOG_FILE:-$REPO_DIR/logs/sync-amalin-$(date +%Y-%m-%d_%H%M).log}"
mkdir -p "$(dirname "$LOG_FILE")"

exec 9>"${LOCK_FILE:-/tmp/sync-amalin.lock}"
if ! flock -n 9; then echo "[$(date)] previous Amalin sync still running — skipping" | tee -a "$LOG_FILE"; exit 0; fi

FORCE_FLAG=""
if [ "${AMALIN_WEEKLY_FORCE:-0}" = "1" ] && [ "$(date +%u)" = "7" ]; then FORCE_FLAG="--force"; fi

echo "=== Amalin sync $(date) shop=$SHOP_DOMAIN ${FORCE_FLAG:-normal} ===" | tee -a "$LOG_FILE"

# The sync prints the store's UserTable record (base.js), access token included — keep it out of the logs.
redact() { sed -E 's/shp(at|ua|ca|ss)_[A-Za-z0-9]+/<redacted>/g; s/("?accessToken"?[:=] *"?)[^",} ]+/\1<redacted>/g'; }

echo "[1/2] sync-modular (full catalogue ${FORCE_FLAG:-new products + stamp all})" | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js shopify "$SHOP_DOMAIN" $FORCE_FLAG 2>&1 | redact | tee -a "$LOG_FILE"

echo "[2/2] prune products no longer in the shop (hard delete, store-scoped)" | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-cleanup-stale.js "$SHOP_DOMAIN" --grace-days 0 2>&1 | redact | tee -a "$LOG_FILE"

echo "=== Amalin sync completed $(date) ===" | tee -a "$LOG_FILE"
