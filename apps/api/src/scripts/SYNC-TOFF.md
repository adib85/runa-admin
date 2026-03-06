# Toff Store Sync — Step-by-Step

Run all commands from the **project root** (`runa-admin/`).

## Step 1 — Sync products from VTEX to Neo4j

Fetches all products from the Toff VTEX catalog, generates AI descriptions (Google Search grounding + image fallback), and saves everything to Neo4j.

```bash
node apps/api/src/scripts/sync-modular.js vtex toffro vtexappkey-toffro-QSQMBT BUWVNSSFHCJHTEXKFXSZXAYEHFCFPOMUCPXCENUMKXVWATHDHQUQKVKDGGNFUTVLNVBDNJAHPIZHLFZKRXNUQNCQQNTJRXMGSNQTKYXDLVNFQICWBDGXTIRPTNAUZWPW
```

Add `--force` to re-process all products (skip existing-product check).

## Step 2 — Push descriptions from Neo4j to VTEX

Copies the AI descriptions already stored in Neo4j (generated during Step 1) into the VTEX catalog. Only updates products that have no description in VTEX yet.

```bash
node apps/api/src/scripts/sync-toff-descriptions.js
```

Options:
- `--dry-run` — check products without writing to VTEX
- `--handle <handle-or-url>` — process a single product

## Step 3 — Generate "Complete The Look" widgets

Calls the outfit-generation Lambda for each product to build "Complete The Look" recommendations.

```bash
node apps/api/src/scripts/sync-lambda-complete-the-look.js toffro.vtexcommercestable.com.br --missing
```

Options:
- `--missing` — only process products that don't have a widget yet
- `--batchSize <n>` — parallel requests (default: 10)
- `--maxProducts <n>` — limit how many products to process
- `--startFrom <n>` — starting offset

## Step 4 — Generate "Similar Products" widgets

Calls the similar-products Lambda for each product to build "Similar Products" recommendations.

```bash
node apps/api/src/scripts/sync-lambda-similar-products.js toffro.vtexcommercestable.com.br --missing
```

Options:
- `--missing` — only process products that don't have a widget yet
- `--batchSize <n>` — parallel requests (default: 10)
- `--maxProducts <n>` — limit how many products to process
- `--startFrom <n>` — starting offset
- `--delay <ms>` — delay between requests in ms (default: 2000)

---

## Run all steps automatically (cron)

A wrapper script runs all 4 steps sequentially, stopping if any step fails. Logs are saved to `apps/api/src/scripts/logs/`.

### Manual run

```bash
bash apps/api/src/scripts/sync-toff-all.sh
```

### Crontab (daily at 3:00 AM)

```bash
crontab -e
```

Add this line (adjust the path and schedule as needed):

```
0 3 * * * /Users/adrian/Mobile/runa-admin/apps/api/src/scripts/sync-toff-all.sh >> /Users/adrian/Mobile/runa-admin/apps/api/src/scripts/logs/cron.log 2>&1
```
