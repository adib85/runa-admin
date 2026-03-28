#!/bin/bash
set -e

# 1. Load the Conda configuration so we can use 'conda activate'
source /home/ec2-user/miniconda3/etc/profile.d/conda.sh

# 2. Activate the environment
conda activate myenv

# 3. Go to the project root
cd /home/ec2-user/runa-admin

SHOP_DOMAIN="${SHOP_DOMAIN:-k8xbf0-5t.myshopify.com}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.1-flash-lite-preview}"
LOG_FILE="/home/ec2-user/runa-admin/logs/sync-runwayher-$(date +%Y-%m-%d_%H%M).log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  RunwayHer Full Sync — $(date)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[Step 1/6] Syncing products from Shopify to Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js shopify "$SHOP_DOMAIN" --demographic woman --rewrite-descriptions --gemini-model "$GEMINI_MODEL" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 2/6] Cleaning up stale products from Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-cleanup-stale.js "$SHOP_DOMAIN" --max-delete-pct 50 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 3/6] Generating Complete The Look widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js "$SHOP_DOMAIN" --missing --gemini-model "$GEMINI_MODEL" --skip-images 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 4/6] Generating Similar Products widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js "$SHOP_DOMAIN" --missing --gemini-model "$GEMINI_MODEL" --skip-images --candidate-limit 15 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 5/6] Pushing descriptions from Neo4j to Shopify..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-shopify-descriptions.js "$SHOP_DOMAIN" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 6/6] Classifying product types via Gemini..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-shopify-product-types.js "$SHOP_DOMAIN" --preset her --missing --gemini-model "$GEMINI_MODEL" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  RunwayHer Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
