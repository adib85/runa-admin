#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Quicklly — full marketplace backfill / daily refresh (decoupled, resumable, gentle)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Two-phase, decoupled flow (see docs/QUICKLLY_INDEXING_PLAN.md):
#   PASS 1 (scrape): hit Quicklly gently, persist every merchant to .quicklly-cache.
#                    Low parallelism — this is the only Cloudflare-exposed step.
#   PASS 2 (write):  read the warm cache (0 Quicklly calls) and run embed+write to
#                    Neo4j fast. Safe to parallelize harder — load lands on the app
#                    box + Neo4j, not Quicklly.
#
# Resumable: each merchant that finishes a pass is appended to a .done file and
# skipped on re-run. Delete the .done file to force a full re-pass.
#
# Usage:
#   bash apps/api/src/scripts/sync-quicklly-all.sh                 # both passes, all merchants
#   PASS=scrape bash .../sync-quicklly-all.sh                      # only warm the cache
#   PASS=write  bash .../sync-quicklly-all.sh                      # only write (assumes cache warm)
#   MERCHANTS="taj-mahal-fresh-market indian-mega-mart" bash ...   # explicit subset
#   FORCE=1 bash .../sync-quicklly-all.sh                          # re-process existing products (daily refresh)
#
# Env knobs:
#   PASS              scrape | write | both        (default: both)
#   MERCHANTS         space-separated slugs         (default: all, via the enumerator)
#   SCRAPE_WAVE       parallel merchants in PASS 1  (default: 2  — gentle on Quicklly)
#   WRITE_WAVE        parallel merchants in PASS 2  (default: 3)
#   FORCE             1 → add --force (re-embed/refresh existing; for daily price/stock)
#   SYNC_CONCURRENCY  per-merchant embedding concurrency (default: 20)
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

# ── Locate repo root (works on EC2 /home/ec2-user/runa-admin and on a laptop) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"

# ── Activate conda env if present (EC2 cron context, like sync-toff-all.sh) ──
if [ -f /home/ec2-user/miniconda3/etc/profile.d/conda.sh ]; then
  source /home/ec2-user/miniconda3/etc/profile.d/conda.sh
  conda activate myenv 2>/dev/null || true
fi

# ── Config ──
PASS="${PASS:-both}"
SCRAPE_WAVE="${SCRAPE_WAVE:-2}"
WRITE_WAVE="${WRITE_WAVE:-3}"
FORCE_FLAG=""
[ "${FORCE:-0}" = "1" ] && FORCE_FLAG="--force"
export SYNC_CONCURRENCY="${SYNC_CONCURRENCY:-20}"
export SYNC_FAST_INDEX=true          # skip the inter-write politeness sleep (own DB)
export SYNC_FETCH_BATCH="${SYNC_FETCH_BATCH:-200}"

STAMP="$(date +%Y-%m-%d_%H%M)"
LOG_DIR="$REPO_ROOT/apps/api/src/scripts/logs"
RUN_DIR="$LOG_DIR/quicklly-$STAMP"
mkdir -p "$RUN_DIR"
SCRAPED_DONE="$LOG_DIR/quicklly-scraped.done"
WRITTEN_DONE="$LOG_DIR/quicklly-written.done"
touch "$SCRAPED_DONE" "$WRITTEN_DONE"
MAIN_LOG="$RUN_DIR/_main.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$MAIN_LOG"; }

# ── Merchant list (explicit override, else enumerate from sitemaps) ──
if [ -n "${MERCHANTS:-}" ]; then
  read -ra MERCHANT_LIST <<< "$MERCHANTS"
else
  log "Enumerating merchants from sitemaps…"
  mapfile -t MERCHANT_LIST < <(node apps/api/src/scripts/list-quicklly-merchants.mjs --slugs 2>>"$MAIN_LOG")
fi
TOTAL=${#MERCHANT_LIST[@]}
if [ "$TOTAL" -eq 0 ]; then log "No merchants found — aborting."; exit 1; fi

log "═══════════════════════════════════════════════════════════"
log "Quicklly sync — PASS=$PASS  merchants=$TOTAL  FORCE=${FORCE:-0}"
log "  scrape_wave=$SCRAPE_WAVE write_wave=$WRITE_WAVE concurrency=$SYNC_CONCURRENCY"
log "  logs: $RUN_DIR"
log "═══════════════════════════════════════════════════════════"

# run_pass <pass-name> <wave-size> <done-file> <extra-args...>
run_pass() {
  local name="$1" wave="$2" donefile="$3"; shift 3
  local extra=("$@")
  local running=0 done_count=0 skip_count=0 i=0

  log "── PASS: $name (wave=$wave) ──"
  for slug in "${MERCHANT_LIST[@]}"; do
    i=$((i+1))
    if grep -qxF "$slug" "$donefile"; then
      skip_count=$((skip_count+1)); continue
    fi
    (
      mlog="$RUN_DIR/${name}-${slug}.log"
      if node apps/api/src/scripts/sync-modular.js quicklly "$slug" "${extra[@]+"${extra[@]}"}" > "$mlog" 2>&1; then
        echo "$slug" >> "$donefile"
        echo "[$(date +%H:%M:%S)] ✓ $name $slug" | tee -a "$MAIN_LOG"
      else
        echo "[$(date +%H:%M:%S)] ✗ $name $slug — see ${name}-${slug}.log" | tee -a "$MAIN_LOG"
      fi
    ) &
    running=$((running+1))
    if [ "$running" -ge "$wave" ]; then wait -n 2>/dev/null || wait; running=$((running-1)); fi
  done
  wait
  done_count=$(wc -l < "$donefile")
  log "── PASS $name complete: $done_count/$TOTAL done ($skip_count skipped this run) ──"
}

# ── PASS 1: scrape-only (gentle) ──
if [ "$PASS" = "scrape" ] || [ "$PASS" = "both" ]; then
  run_pass "scrape" "$SCRAPE_WAVE" "$SCRAPED_DONE" --scrape-only
fi

# ── PASS 2: write (embed + Neo4j) ──
if [ "$PASS" = "write" ] || [ "$PASS" = "both" ]; then
  run_pass "write" "$WRITE_WAVE" "$WRITTEN_DONE" $FORCE_FLAG
fi

log "═══════════════════════════════════════════════════════════"
log "Quicklly sync finished. Scraped: $(wc -l <"$SCRAPED_DONE")  Written: $(wc -l <"$WRITTEN_DONE")  (of $TOTAL)"
log "═══════════════════════════════════════════════════════════"
