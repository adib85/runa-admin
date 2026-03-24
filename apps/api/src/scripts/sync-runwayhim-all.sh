#!/bin/bash
set -e

# 1. Load the Conda configuration so we can use 'conda activate'
source /home/ec2-user/miniconda3/etc/profile.d/conda.sh

# 2. Activate the environment
conda activate myenv

# 3. Go to the project root
cd /home/ec2-user/runa-admin

SHOP_DOMAIN="${SHOP_DOMAIN:-wp557k-d1.myshopify.com}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.1-flash-lite-preview}"

APP_SERVER_URL="https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app"
echo "Fetching ACCESS_TOKEN from database for $SHOP_DOMAIN..."
ACCESS_TOKEN=$(curl -s "${APP_SERVER_URL}?action=getUser&shop=${SHOP_DOMAIN}" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { const r=JSON.parse(d); process.stdout.write(r.data?.accessToken||''); }
    catch(e){ process.stderr.write('Failed to parse response\n'); process.exit(1); }
  });
")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: Could not fetch ACCESS_TOKEN from database for shop $SHOP_DOMAIN"
  exit 1
fi
echo "ACCESS_TOKEN fetched successfully."
LOG_FILE="/home/ec2-user/runa-admin/logs/sync-runawayhim-$(date +%Y-%m-%d_%H%M).log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  RunawayHim Full Sync — $(date)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[Step 1/5] Syncing products from Shopify to Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js shopify "$SHOP_DOMAIN" "$ACCESS_TOKEN" --demographic man --rewrite-descriptions --gemini-model "$GEMINI_MODEL" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 2/5] Cleaning up stale products from Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-cleanup-stale.js "$SHOP_DOMAIN" 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 3/5] Generating Complete The Look widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js "$SHOP_DOMAIN" --missing --gemini-model "$GEMINI_MODEL" --skip-images 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 4/5] Generating Similar Products widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js "$SHOP_DOMAIN" --missing --gemini-model "$GEMINI_MODEL" --skip-images --candidate-limit 15 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 5/5] Pushing descriptions from Neo4j to Shopify..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-shopify-descriptions.js "$SHOP_DOMAIN" "$ACCESS_TOKEN" --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  RunawayHim Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
