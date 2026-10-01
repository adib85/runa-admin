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
#   FORCE_SLICE       N → rolling full re-index: each run writes 1/N of the stores with --force,
#                     a different slice every day, so every store is rebuilt once per N days
#                     (nightly cron: 28). See "Rolling full re-index" below.
#   SYNC_CONCURRENCY  per-merchant embedding concurrency (default: 20)
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

# ── One run at a time ──
# Two schedules once fired on the same night (cron treats a restricted day-of-month AND a
# restricted day-of-week as OR: `30 3 2-31 * 0` also runs every weekday) and both syncs ran
# concurrently — twice the load on Quicklly, interleaved logs, one nationwide-ZIP apply failing
# because the other had just deleted the cache. A lock makes that impossible whatever cron does.
exec 9>/tmp/quicklly-sync.lock
if ! flock -n 9; then echo "[$(date +%H:%M:%S)] another Quicklly sync is already running — exiting"; exit 0; fi

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

# ── Rolling full re-index (FORCE_SLICE=N) ──
# A normal run refreshes price, stock, sale and fast-delivery on existing products and indexes
# new ones; their title, image and category (and the embeddings built from them) only change in
# a --force write. That used to be a monthly `FRESH=all FORCE=1` cron line. The first time it
# fired (2026-10-01) it needed ~35 h for ~1M products and held the lock the whole time, so no
# price refresh could run — it was stopped after 26 of 225 stores.
# Instead, each nightly run forces a slice: a store belongs to slice `cksum(slug) % N` (stable
# when stores come and go) and tonight's slice is `days-since-epoch % N`. With N=28 that is ~9
# stores a night and every store rebuilt once every four weeks, with no long run.
# FORCE=1 still forces everything; the midday run sets no FORCE_SLICE and forces nothing.
FORCE_SLICE="${FORCE_SLICE:-0}"
case "$FORCE_SLICE" in ''|*[!0-9]*) FORCE_SLICE=0 ;; esac
SLICE_DAY="${FORCE_SLICE_DAY:-$(( $(date +%s) / 86400 ))}"   # FORCE_SLICE_DAY: tests only
in_force_slice() {
  [ "$FORCE_SLICE" -gt 0 ] || return 1
  local h
  h=$(printf '%s' "$1" | cksum | cut -d' ' -f1)
  [ $(( h % FORCE_SLICE )) -eq $(( SLICE_DAY % FORCE_SLICE )) ]
}

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
#   FRESH=listings → clear the LISTING responses only, keep the product pages (pdp-*.html): the
#                    light midday refresh — prices, badges and stock come from the listings, and a
#                    product page is re-fetched by the provider only where the price moved
#   FRESH=all      → clear the entire cache (also re-discover) → MONTHLY (pair with FORCE=1)
CACHE_DIR="$REPO_ROOT/.quicklly-cache"
if [ "${FRESH:-}" = "products" ]; then
  rm -rf "$CACHE_DIR/api-responses"/* 2>/dev/null
  rm -f "$SCRAPED_DONE" "$WRITTEN_DONE"; touch "$SCRAPED_DONE" "$WRITTEN_DONE"
  log "FRESH=products → cleared api-responses cache + reset .done (daily refresh)"
elif [ "${FRESH:-}" = "listings" ]; then
  find "$CACHE_DIR/api-responses" -maxdepth 1 -type f ! -name 'pdp-*.html' -delete 2>/dev/null
  rm -f "$SCRAPED_DONE" "$WRITTEN_DONE"; touch "$SCRAPED_DONE" "$WRITTEN_DONE"
  log "FRESH=listings → cleared listing responses (kept product pages) + reset .done (midday refresh)"
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
  # sitemap (the old enumerator) misses 9 live stores and still lists 8 dead ones. The build
  # also asks Quicklly's availability API, per ZIP, WHERE each store delivers (nationwide store
  # included) and writes that to the graph's DELIVERS_TO edges before the product sync starts.
  # Falls back to the sitemap enumerator only if the directory cannot be built (network down).
  log "Building the store directory (near-me pages + per-ZIP availability API)…"
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
  # Tonight's slice of the rolling full re-index (write pass only; FORCE=1 already forces all).
  local slicing=0
  if [ "$name" = "write" ] && [ -z "$FORCE_FLAG" ] && [ "$FORCE_SLICE" -gt 0 ]; then
    slicing=1
    local in_slice=""
    for slug in "${MERCHANT_LIST[@]}"; do in_force_slice "$slug" && in_slice="$in_slice $slug"; done
    log "Rolling full re-index: slice $(( SLICE_DAY % FORCE_SLICE + 1 )) of $FORCE_SLICE → $(echo $in_slice | wc -w | tr -d ' ') of $TOTAL stores are written with --force:${in_slice:- none}"
  fi
  for slug in "${MERCHANT_LIST[@]}"; do
    i=$((i+1))
    if grep -qxF "$slug" "$donefile"; then
      skip_count=$((skip_count+1)); continue
    fi
    local args=("${extra[@]+"${extra[@]}"}") note=""
    if [ "$slicing" = "1" ] && in_force_slice "$slug"; then args+=("--force"); note=" (full re-index)"; fi
    (
      mlog="$RUN_DIR/${name}-${slug}.log"
      if node apps/api/src/scripts/sync-modular.js quicklly "$slug" "${args[@]+"${args[@]}"}" > "$mlog" 2>&1; then
        echo "$slug" >> "$donefile"
        echo "[$(date +%H:%M:%S)] ✓ $name $slug$note" | tee -a "$MAIN_LOG"
      else
        echo "[$(date +%H:%M:%S)] ✗ $name $slug$note — see ${name}-${slug}.log" | tee -a "$MAIN_LOG"
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

# ── Nationwide store: full-US ZIP list ──
# The nationwide store (345) ships to ZIPs far outside the 813 near-me cities; its per-ZIP verdict
# from Quicklly's availability API is kept on the Store node (s.zips). Re-applied from the cache
# every run; re-probed from scratch weekly (NATIONWIDE_ZIPS=full, ~40 min at 8-way) — or the first
# time, when there is no cache yet.
# The weekly re-probe is decided HERE (Sunday, `date +%u` = 7), not by a second cron line.
if [ -z "${MERCHANTS:-}" ]; then
  if [ "${NATIONWIDE_ZIPS:-}" = "full" ] || [ "$(date +%u)" = "7" ] || [ ! -f "$CACHE_DIR/nationwide-zips.json" ]; then
    log "── Nationwide store: probing every US ZIP (weekly) ──"
    [ "${NATIONWIDE_ZIPS:-}" = "full" ] && rm -f "$CACHE_DIR/nationwide-zips.json"
    node apps/api/src/scripts/quicklly-nationwide-zips.mjs --apply >> "$MAIN_LOG" 2>&1 || log "nationwide ZIP probe failed (non-fatal)"
  else
    node apps/api/src/scripts/quicklly-nationwide-zips.mjs --apply --no-probe >> "$MAIN_LOG" 2>&1 || log "nationwide ZIP apply failed (non-fatal)"
  fi
fi

# ── Per-ZIP store list (quicklly.com's "Grocery stores near you", for every US ZIP) ──
# The chat's store list for a ZIP follows it (:QuickllyZip nodes). Stores change ZIPs rarely, so
# the ~42.5k-call probe runs weekly (Sunday), or when the cache is missing; every other run only
# re-applies the cache, which also maps stores indexed since. Non-fatal either way.
if [ -z "${MERCHANTS:-}" ]; then
  if [ "${ZIP_STORES:-}" = "full" ] || [ "$(date +%u)" = "7" ] || [ ! -f "$CACHE_DIR/zip-stores.json" ]; then
    log "── Per-ZIP store list: probing every US ZIP (weekly) ──"
    node apps/api/src/scripts/quicklly-zip-stores.mjs --apply --fresh >> "$MAIN_LOG" 2>&1 || log "per-ZIP store list probe failed (non-fatal)"
  else
    log "── Per-ZIP store list: re-applying the cached list ──"
    node apps/api/src/scripts/quicklly-zip-stores.mjs --apply --no-probe >> "$MAIN_LOG" 2>&1 || log "per-ZIP store list apply failed (non-fatal)"
  fi
fi

# ── Fast delivery ("⚡ Delivery in 3 hours or less") ──
# Store-level flag from Quicklly's own store-list API — what their store cards show and what the
# chat surfaces as the bolt. Refreshed on every run (nightly + midday); non-fatal, and the script
# keeps the previous values if the API answers for too few stores.
if [ -z "${MERCHANTS:-}" ]; then
  log "── Fast delivery: store-level instant-delivery flag ──"
  node apps/api/src/scripts/quicklly-instant-delivery.mjs --apply >> "$MAIN_LOG" 2>&1 || log "instant-delivery refresh failed (non-fatal)"
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
