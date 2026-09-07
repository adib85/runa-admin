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

# ── Refresh modes (for recurring cron) ──
# The disk cache is permanent (a plain re-run reads stale prices). FRESH busts it so a
# scheduled refresh actually re-fetches, and resets the .done files so every store is
# re-processed (not skipped as "already done").
#   FRESH=products → clear api-responses only (re-fetch prices/stock; keep discovery cache) → DAILY
#   FRESH=all      → clear the entire cache (also re-discover) → MONTHLY (pair with FORCE=1)
CACHE_DIR="$REPO_ROOT/.quicklly-cache"
if [ "${FRESH:-}" = "products" ]; then
  rm -rf "$CACHE_DIR/api-responses"/* 2>/dev/null
  rm -f "$SCRAPED_DONE" "$WRITTEN_DONE"; touch "$SCRAPED_DONE" "$WRITTEN_DONE"
  log "FRESH=products → cleared api-responses cache + reset .done (daily refresh)"
elif [ "${FRESH:-}" = "all" ]; then
  rm -rf "$CACHE_DIR"/* 2>/dev/null
  rm -f "$SCRAPED_DONE" "$WRITTEN_DONE"; touch "$SCRAPED_DONE" "$WRITTEN_DONE"
  log "FRESH=all → cleared entire cache + reset .done (monthly full refresh)"
fi

# ── Merchant list (explicit override, else enumerate from sitemaps) ──
if [ -n "${MERCHANTS:-}" ]; then
  read -ra MERCHANT_LIST <<< "$MERCHANTS"
else
  # Store directory from every city's near-me page — the list shoppers actually see. The
  # sitemap (the old enumerator) misses 9 live stores and still lists 8 dead ones. Falls back
  # to the sitemap enumerator only if the directory cannot be built (network down, etc.).
  log "Building the store directory from Quicklly's near-me pages…"
  mapfile -t MERCHANT_LIST < <(node apps/api/src/scripts/quicklly-store-directory.mjs --slugs 2>>"$MAIN_LOG")
  if [ "${#MERCHANT_LIST[@]}" -lt 20 ]; then
    log "Directory came back with ${#MERCHANT_LIST[@]} stores — falling back to the sitemap enumerator"
    mapfile -t MERCHANT_LIST < <(node apps/api/src/scripts/list-quicklly-merchants.mjs --slugs 2>>"$MAIN_LOG")
    printf '%s\n' "${MERCHANT_LIST[@]}" | grep -qx "quicklly-indian-grocery-nationwide" \
      || MERCHANT_LIST+=("quicklly-indian-grocery-nationwide")
  fi
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

# ── Retire dead stores ──
# A store no near-me page lists any more cannot take an order; stop offering its products.
# Reversible: a later directory that lists it again flips them back on the next sync.
if [ -z "${MERCHANTS:-}" ]; then
  log "── Retiring stores absent from the directory ──"
  node apps/api/src/scripts/quicklly-store-directory.mjs --retire-dead >> "$MAIN_LOG" 2>&1 || log "retire-dead failed (non-fatal)"
fi

# ── Health check ──
# The Aug 2026 outage exited 0 while writing nothing, so "the script finished" is not
# evidence the catalog is alive. Ask the database instead. Non-fatal here (the run is
# already over) — it alerts on its own and its exit code lands in the log.
log "── Health check ──"
if node apps/api/src/scripts/quicklly-health-check.mjs >> "$MAIN_LOG" 2>&1; then
  log "Health check PASSED"
else
  log "Health check FAILED — see $MAIN_LOG (alert sent if a channel is configured)"
fi
