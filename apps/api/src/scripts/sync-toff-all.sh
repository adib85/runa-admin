#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$PROJECT_ROOT"

LOG_FILE="$PROJECT_ROOT/apps/api/src/scripts/logs/sync-toff-$(date +%Y-%m-%d_%H%M).log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Toff Full Sync — $(date)" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"

echo ""
echo "[Step 1/4] Syncing products from VTEX to Neo4j..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-modular.js vtex toffro vtexappkey-toffro-QSQMBT BUWVNSSFHCJHTEXKFXSZXAYEHFCFPOMUCPXCENUMKXVWATHDHQUQKVKDGGNFUTVLNVBDNJAHPIZHLFZKRXNUQNCQQNTJRXMGSNQTKYXDLVNFQICWBDGXTIRPTNAUZWPW 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 2/4] Pushing descriptions from Neo4j to VTEX..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-toff-descriptions.js 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 3/4] Generating Complete The Look widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-complete-the-look.js toffro.vtexcommercestable.com.br --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "[Step 4/4] Generating Similar Products widgets..." | tee -a "$LOG_FILE"
node apps/api/src/scripts/sync-lambda-similar-products.js toffro.vtexcommercestable.com.br --missing 2>&1 | tee -a "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  Toff Full Sync completed — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
