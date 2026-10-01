#!/bin/bash
# Index Quicklly stores that their per-ZIP store list returns but no near-me page links (so the
# nightly directory never found them). One-off backfill; afterwards the regular sync keeps them
# fresh, because the directory now adds such stores itself (quicklly-store-directory.mjs).
#
# Runs OUTSIDE the nightly sync's lock and in its OWN cache root, so it never touches the files of
# a sync that is running. Usage:
#   quicklly-backfill-new-stores.sh <slug-list-file> [workers=3]
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"
LIST="${1:?slug list file}"; WORKERS="${2:-3}"
NODE_BIN="${NODE_BIN:-/home/ec2-user/miniconda3/envs/myenv/bin/node}"
export QUICKLLY_CACHE_ROOT="${QUICKLLY_CACHE_ROOT:-$REPO_ROOT/.quicklly-cache-newstores}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
export SYNC_CONCURRENCY="${SYNC_CONCURRENCY:-12}" SYNC_FAST_INDEX=true SYNC_FETCH_BATCH="${SYNC_FETCH_BATCH:-200}"
RUN_DIR="$REPO_ROOT/logs/quicklly-newstores-$(date +%Y-%m-%d_%H%M)"; mkdir -p "$RUN_DIR"
DONE="$QUICKLLY_CACHE_ROOT/backfill.done"; touch "$DONE"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RUN_DIR/_main.log"; }
[ -f "$QUICKLLY_CACHE_ROOT/directory.json" ] || { log "no directory.json in $QUICKLLY_CACHE_ROOT"; exit 2; }
TODO=$(grep -vxFf "$DONE" "$LIST" | grep -c . || true)
log "backfill: $(grep -c . "$LIST") stores listed, $TODO to do, $WORKERS workers, cache $QUICKLLY_CACHE_ROOT"
one() {
  slug="$1"
  if nice -n 10 "$NODE_BIN" apps/api/src/scripts/sync-modular.js quicklly "$slug" > "$RUN_DIR/$slug.log" 2>&1; then
    echo "$slug" >> "$DONE"; echo "[$(date +%H:%M:%S)] ✓ $slug ($(grep -c 'products saved' "$RUN_DIR/$slug.log") batches)" | tee -a "$RUN_DIR/_main.log"
  else
    echo "[$(date +%H:%M:%S)] ✗ $slug — see $RUN_DIR/$slug.log" | tee -a "$RUN_DIR/_main.log"
  fi
}
export -f one; export RUN_DIR DONE NODE_BIN
grep -vxFf "$DONE" "$LIST" | xargs -P "$WORKERS" -I{} bash -c 'one "$@"' _ {}
log "stores done: $(grep -c . "$DONE") — mapping them into the per-ZIP lists and fast-delivery flags"
# main cache root for these two: they read zip-stores.json / write the graph
QUICKLLY_CACHE_ROOT="$REPO_ROOT/.quicklly-cache" "$NODE_BIN" apps/api/src/scripts/quicklly-zip-stores.mjs --apply --no-probe >> "$RUN_DIR/_main.log" 2>&1 || log "zip-stores apply failed"
"$NODE_BIN" apps/api/src/scripts/quicklly-instant-delivery.mjs --apply >> "$RUN_DIR/_main.log" 2>&1 || log "instant-delivery apply failed"
log "backfill finished"
