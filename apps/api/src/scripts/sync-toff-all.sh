#!/bin/bash
set -e

# 1. Load the Conda configuration so we can use 'conda activate'
source /home/ec2-user/miniconda3/etc/profile.d/conda.sh

# 2. Activate the environment
conda activate myenv

# 3. Go to the project root
cd /home/ec2-user/runa-admin

LOG_FILE="/home/ec2-user/runa-admin/logs/sync-toff-$(date +%Y-%m-%d_%H%M).log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Toff Full Sync — $(date)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[Step 1/5] Syncing products from VTEX to Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js vtex toffro vtexappkey-toffro-QSQMBT BUWVNSSFHCJHTEXKFXSZXAYEHFCFPOMUCPXCENUMKXVWATHDHQUQKVKDGGNFUTVLNVBDNJAHPIZHLFZKRXNUQNCQQNTJRXMGSNQTKYXDLVNFQICWBDGXTIRPTNAUZWPW 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 2/5] Pushing descriptions from Neo4j to VTEX..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-toff-descriptions.js 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 3/5] Pushing SEO (Title + MetaTagDescription) from Neo4j to VTEX..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-toff-seo.js 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 4/5] Generating Complete The Look widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js toffro.vtexcommercestable.com.br --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 5/5] Generating Similar Products widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js toffro.vtexcommercestable.com.br --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Toff Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
