#!/bin/bash
set -e

# 1. Load the Conda configuration so we can use 'conda activate'
source /home/ec2-user/miniconda3/etc/profile.d/conda.sh

# 2. Activate the environment
conda activate myenv

# 3. Go to the project root
cd /home/ec2-user/runa-admin

SHOP_DOMAIN="${SHOP_DOMAIN:-k8xbf0-5t.myshopify.com}"
ACCESS_TOKEN="${ACCESS_TOKEN:?Set ACCESS_TOKEN env var}"

LOG_FILE="/home/ec2-user/runa-admin/logs/sync-runwayher-$(date +%Y-%m-%d_%H%M).log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  RunwayHer Full Sync — $(date)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[Step 1/4] Syncing products from Shopify to Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js shopify "$SHOP_DOMAIN" "$ACCESS_TOKEN" --demographic woman 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 2/4] Generating Complete The Look widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 3/4] Generating Similar Products widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js "$SHOP_DOMAIN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 4/4] Pushing descriptions from Neo4j to Shopify..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-shopify-descriptions.js "$SHOP_DOMAIN" "$ACCESS_TOKEN" --recent 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  RunwayHer Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
