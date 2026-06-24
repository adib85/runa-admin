# Quicklly — Full Catalog Indexing (plan & handoff)

## Goal
Index **all** Quicklly stores/products into Neo4j so the "Ask Quicklly" assistant works across
all their locations, then keep it fresh with a **daily** sync. The chat runtime (separate
`runa_serverless` repo) only *reads* Neo4j — all indexing happens here in `runa-admin`.

## Guardrail (important)
**Discuss before doing anything.** Don't run syncs, don't crawl, don't write scripts yet.
First work through the analysis + improvements below *as a discussion*, propose options, and wait
for explicit go-ahead. Phase 0 is analysis only (read-only) and even that needs an OK first.

## What already exists
- Per-store indexer: `apps/api/src/scripts/sync-modular.js`
  - `node apps/api/src/scripts/sync-modular.js quicklly <merchant-slug> [--force] [--max N] [--dry-run] [--since 2d]`
  - Pipeline: crawl Quicklly's public storefront → normalize → OpenAI `text-embedding-3-small`
    (4 vectors/product) → Neo4j `MERGE` (idempotent, resumable via progress file).
- Neo4j is the **same DB the chat reads** (`(Store)-[:HAS_PRODUCT]->(Product)`,
  `(Store)-[:DELIVERS_TO]->(Location)`). Creds in `runa-admin/.env`
  (`NEO4J_*`, `OPENAI_API_KEY`, `AWS_*`).
- Known Sunnyvale stores: `taj-mahal-fresh-market`, `indian-mega-mart`, `desi-india-bazaar`,
  `new-nilgiri-cash-carry`.

## Phased plan
- **Phase 0 — Analyze & size (read-only):** count merchants (+ per-city), sample a few stores for
  product counts, estimate total products, crawl time (~30–45 min/store), and embedding cost.
  Output a sized go-plan. *Discuss results before proceeding.*
- **Phase A — Validate:** one `--dry-run` (no writes) to confirm creds + crawler.
- **Phase B — Seed launch stores:** index the 4 Sunnyvale stores for real → preview live.
- **Phase C — Full marketplace:** enumerate all merchants → batch-sync in waves (2–3 parallel),
  resumable.
- **Phase D — Daily refresh:** the batch loop on a schedule.

## Improvements to design (discussion items — don't build yet)
1. **Scope** — entire marketplace vs. launch cities first.
2. **Where it runs** — currently manual from a laptop; "daily" needs a persistent host
   (server / EC2 / cron).
3. **Missing scripts** — a merchant enumerator (`list-quicklly-merchants.mjs`) + a batch runner
   (`sync-quicklly-all.sh`); neither exists.
4. **Politeness / parallelism** — agree how hard to crawl a partner's site.
5. **Resume / retry / monitoring** — done-file, failure retries, per-city verification in chat.
6. **Neo4j capacity** — confirm headroom (4 embedding vectors/product) before scaling up.

## Key facts
- **Idempotent:** re-run anytime; MERGE refreshes, no dupes.
- **Cost is time, not money:** embeddings are pennies; polite crawl delays dominate.
- **Source:** public storefront endpoints (product API `ajax-subcat-all-products.php` +
  store/category pages + sitemap for discovery).
