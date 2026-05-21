#!/usr/bin/env node
/**
 * Re-check products that returned 429 in the audit, with low concurrency
 * and exponential backoff, to separate "real broken" from "rate-limited".
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import neo4j from "neo4j-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const STORE_ID = "toffro.vtexcommercestable.com.br";

function getDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function fetchAll() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product) WHERE p.storeId = $storeId
       RETURN p.id AS id, p.handle AS handle, p.image AS image`,
      { storeId: STORE_ID }
    );
    return r.records.map(x => ({ id: x.get("id"), handle: x.get("handle"), image: x.get("image") }));
  } finally { await session.close(); await driver.close(); }
}

async function head(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
    return r.status;
  } catch (e) {
    return e.name === "AbortError" ? 0 : -1;
  } finally { clearTimeout(t); }
}

async function headWithBackoff(url) {
  const delays = [0, 600, 1500, 3500, 8000];
  let lastStatus = 0;
  for (const d of delays) {
    if (d) await new Promise(r => setTimeout(r, d));
    lastStatus = await head(url);
    if (lastStatus !== 429) return lastStatus;
  }
  return lastStatus;
}

async function main() {
  console.log(`Loading TOFF products...`);
  const products = await fetchAll();
  console.log(`  ${products.length} products\n`);

  // Pass 1: quick check at concurrency 6 (gentle)
  console.log(`Pass 1: HEAD-check all with concurrency 6...`);
  const results = [];
  let i = 0, done = 0;
  const CONC = 6;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) {
      const my = i++;
      if (my >= products.length) return;
      const p = products[my];
      const status = await head(p.image);
      results.push({ ...p, status });
      done++;
      if (done % 200 === 0) process.stdout.write(`\r  ${done}/${products.length}`);
    }
  }));
  process.stdout.write(`\r  ${done}/${products.length}\n\n`);

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log("Pass 1 status breakdown:", counts);

  // Pass 2: retry 429s with backoff, sequentially
  const ratelimited = results.filter(r => r.status === 429);
  console.log(`\nPass 2: re-check ${ratelimited.length} rate-limited URLs sequentially with backoff...`);
  let resolved404 = 0, resolved200 = 0, resolvedOther = 0, stillRateLimited = 0;
  for (let idx = 0; idx < ratelimited.length; idx++) {
    const p = ratelimited[idx];
    const finalStatus = await headWithBackoff(p.image);
    p.finalStatus = finalStatus;
    if (finalStatus === 200) resolved200++;
    else if (finalStatus === 404) resolved404++;
    else if (finalStatus === 429) stillRateLimited++;
    else resolvedOther++;
    if ((idx + 1) % 20 === 0) process.stdout.write(`\r  ${idx + 1}/${ratelimited.length}`);
  }
  process.stdout.write(`\r  ${ratelimited.length}/${ratelimited.length}\n`);

  console.log(`\nPass 2 results for previously-429 URLs:`);
  console.log(`  → 200 OK:           ${resolved200}`);
  console.log(`  → 404 Not Found:    ${resolved404}`);
  console.log(`  → still 429:        ${stillRateLimited}`);
  console.log(`  → other status:     ${resolvedOther}`);

  // Final tally
  const final200 = (counts[200] || 0) + resolved200;
  const final404 = (counts[404] || 0) + resolved404;
  const final5xx = Object.entries(counts).filter(([s]) => s.startsWith("5")).reduce((a, [, v]) => a + v, 0);
  const finalOther = (counts[0] || 0) + resolvedOther + stillRateLimited;
  const total = products.length;

  console.log(`\n══ FINAL TALLY (${total} TOFF products) ══`);
  console.log(`  ✓ 200 OK:                  ${final200}  (${pct(final200, total)})`);
  console.log(`  ✗ 404 Not Found (BROKEN):  ${final404}  (${pct(final404, total)})`);
  console.log(`  ? 5xx server errors:       ${final5xx}  (${pct(final5xx, total)})`);
  console.log(`  ? other / inconclusive:    ${finalOther}  (${pct(finalOther, total)})`);
  console.log(`\n  Real confirmed broken:    ${final404}  (${pct(final404, total)})`);
}

function pct(n, t) { return t ? `${((n / t) * 100).toFixed(1)}%` : "0%"; }

main().catch(e => { console.error(e); process.exit(1); });
