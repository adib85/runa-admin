#!/usr/bin/env node

/**
 * End-to-end test for the (already-deployed) Bronze Snake ask-ai prompt.
 *
 *   1. Picks 100 random Bronze Snake products from Neo4j.
 *   2. For each: deletes the existing `userOptions_<handle>_en` cache
 *      item, calls the ask-ai Lambda with `skipCaching=true` so it
 *      regenerates against the current deployed prompt, then writes the
 *      fresh chips back to DynamoDB (same key the existing pipeline uses).
 *   3. Runs the audit logic from
 *      `audit-bronzesnake-user-options-quality.mjs` inline on just those
 *      100 sets and prints the failure breakdown.
 *
 * Output:
 *   - per-product issues (only the failing/warning sets)
 *   - summary: total sets, hard issues, clean, counts by code
 *   - the 100 handles tested are also dumped to /tmp/bronze-100-handles.txt
 *
 * Usage:
 *   node apps/api/src/scripts/test-bronzesnake-user-options-fresh-100.mjs
 *     [--n <count>]         number of products (default: 100)
 *     [--concurrency <n>]   parallel Lambda calls (default: 8)
 *     [--show-ok]           also print clean sets in the report
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import neo4j from "neo4j-driver";
import fetch from "node-fetch";
import AWS from "aws-sdk";
import { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, AWS_REGION } from "../sync/services/config.js";

// ─── Constants ───────────────────────────────────────────────────────

const STORE = "bronze-snake-1.myshopify.com";
const LANGUAGE = "en";
const ASK_AI_LAMBDA_URL = "https://376jtm5kvrmblt45jdduztivku0odqxn.lambda-url.us-east-1.on.aws/";
const HANDLES_DUMP = "/tmp/bronze-100-handles.txt";

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";

// ─── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : d;
};
const SAMPLE_SIZE = parseInt(opt("n", "100"), 10);
const CONCURRENCY = Math.max(1, parseInt(opt("concurrency", "8"), 10));
const SHOW_OK = flag("show-ok");

// ─── Neo4j: random sample ────────────────────────────────────────────

async function pickRandomProducts(count) {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const r = await session.run(
      `MATCH (p:Product)
       WHERE p.storeId = $storeId
         AND p.handle IS NOT NULL AND p.handle <> ''
       WITH p, rand() AS r
       ORDER BY r
       LIMIT $count
       RETURN p.id AS id, p.title AS title, p.handle AS handle`,
      { storeId: STORE, count: neo4j.int(count) }
    );
    return r.records.map((rec) => ({
      id: rec.get("id"),
      title: rec.get("title"),
      handle: rec.get("handle"),
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

// ─── Lambda call + cache write ───────────────────────────────────────

function cacheKey(handle) {
  return `${STORE}_userOptions_${handle.toLowerCase()}_${LANGUAGE}`;
}

async function deleteCache(handle) {
  await ddb.delete({ TableName: CACHE_TABLE, Key: { id: cacheKey(handle) } }).promise();
}

async function writeCache(handle, options) {
  await ddb.put({
    TableName: CACHE_TABLE,
    Item: {
      id: cacheKey(handle),
      storeId: STORE,
      data: { userOptions: options },
      updatedAt: new Date().toISOString(),
    },
  }).promise();
}

async function callLambda(handle) {
  const params = new URLSearchParams({
    domain: STORE,
    handle,
    language: LANGUAGE,
    skipCaching: "true",
  });
  const url = `${ASK_AI_LAMBDA_URL}?${params.toString()}`;
  const resp = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json().catch(() => ({}));
  const arr = json?.data?.userOptions;
  return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim().length > 0) : [];
}

async function regenOne(product) {
  try {
    await deleteCache(product.handle);
    const options = await callLambda(product.handle);
    if (options.length > 0) await writeCache(product.handle, options);
    return { handle: product.handle, options, error: null };
  } catch (e) {
    return { handle: product.handle, options: [], error: e.message };
  }
}

// ─── Audit logic (mirrors audit-bronzesnake-user-options-quality.mjs) ─

const MAX_CHARS = 55;

const OCCASION_WORDS = [
  "office", "work", "workwear", "workday",
  "wedding", "weddings",
  "dinner", "dinners", "lunch", "brunch", "breakfast",
  "date night", "date-night",
  "party", "parties", "cocktail", "cocktails",
  "gala", "ceremony",
  "weekend", "weekends",
  "vacation", "vacations", "holiday", "holidays", "getaway", "trip",
  "travel", "commute", "commuting",
  "gym", "workout", "yoga", "athleisure setting",
  "beach", "poolside", "pool day",
  "lounge", "lounging",
  "festival", "concert",
  "school", "campus", "class",
  "daytime", "day to night", "day-to-night",
  "evening", "evenings", "nighttime", "night out",
  "morning", "afternoon",
  "summer", "winter", "spring", "autumn", "fall",
  "smart casual", "smart-casual", "business casual", "business-casual",
  "formal occasion", "formal occasions",
  "office-appropriate", "office appropriate",
  "occasion", "occasions",
];
const FORBIDDEN_VOCAB = [
  "cheap", "affordable", "bargain", "deal",
  "basic", "fast fashion", "hype", "copycat", "generic", "mass-produced", "mass produced",
  "on sale", "sale price",
];
const VAGUE_PHRASES = ["this piece", "this item", "this product", "this thing"];
const RESTATES_CTL = [
  "matching products", "matching product",
  "what does it pair with", "what does this pair with",
  "what goes with this", "what goes with it",
];
const PLURAL_NOUNS = ["jeans", "pants", "trousers", "shorts", "leggings", "joggers", "tights", "sunglasses", "earrings"];
const PRODUCT_NOUNS = [
  "jacket", "blazer", "coat", "trench", "parka", "vest", "gilet",
  "shirt", "blouse", "top", "tee", "t-shirt", "tshirt", "tank", "polo",
  "hoodie", "sweatshirt", "sweater", "jumper", "knit", "cardigan",
  "dress", "skirt", "jumpsuit", "romper",
  "jeans", "pants", "trousers", "shorts", "leggings", "joggers", "tights", "chinos", "culottes",
  "bikini", "swimsuit", "swimwear", "one-piece",
  "necklace", "earrings", "earring", "bracelet", "ring", "pendant", "choker",
  "sunglasses", "glasses", "hat", "cap", "beanie", "scarf", "belt", "socks",
  "bag", "tote", "clutch", "backpack", "crossbody",
  "boots", "boot", "sneakers", "sneaker", "heels", "heel", "loafers", "loafer", "sandals", "sandal", "mules", "mule", "flats", "flat", "shoes", "shoe",
];

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function containsPhrase(lc, needle) {
  if (/\s|-/.test(needle)) return lc.includes(needle);
  return new RegExp(`\\b${escapeReg(needle)}\\b`, "i").test(lc);
}

function checkQuestion(q) {
  const issues = [], warnings = [];
  if (typeof q !== "string") { issues.push({ code: "NOT_STRING" }); return { issues, warnings }; }
  const t = q.trim();
  if (!t) { issues.push({ code: "EMPTY" }); return { issues, warnings }; }
  if (t.length > MAX_CHARS) issues.push({ code: "TOO_LONG", detail: `${t.length} chars` });
  if (/\byou\b|\byour\b|\byou're\b|\byours\b/i.test(t)) issues.push({ code: "SECOND_PERSON" });
  const lc = t.toLowerCase();
  const occ = OCCASION_WORDS.filter((w) => containsPhrase(lc, w));
  if (occ.length) issues.push({ code: "OCCASION", detail: occ.join(", ") });
  const voc = FORBIDDEN_VOCAB.filter((w) => containsPhrase(lc, w));
  if (voc.length) issues.push({ code: "FORBIDDEN_VOCAB", detail: voc.join(", ") });
  const vag = VAGUE_PHRASES.filter((p) => lc.includes(p));
  if (vag.length) issues.push({ code: "VAGUE", detail: vag.join(", ") });
  for (const n of PLURAL_NOUNS) {
    if (new RegExp(`\\bthis\\s+${n}\\b`, "i").test(t)) issues.push({ code: "GRAMMAR_PLURAL", detail: `"this ${n}"` });
  }
  const ctl = RESTATES_CTL.filter((p) => lc.includes(p));
  if (ctl.length) warnings.push({ code: "RESTATES_CTL", detail: ctl.join(", ") });
  return { issues, warnings };
}

function checkSet(options) {
  const setIssues = [], setWarnings = [];
  if (!Array.isArray(options)) { setIssues.push({ code: "NOT_ARRAY" }); return { perQuestion: [], setIssues, setWarnings }; }
  if (options.length !== 3) setIssues.push({ code: "WRONG_COUNT", detail: `${options.length}` });
  const perQuestion = options.map(checkQuestion);
  const seen = new Map();
  options.forEach((q, i) => {
    if (typeof q !== "string") return;
    const k = q.trim().toLowerCase();
    if (!k) return;
    if (seen.has(k)) setIssues.push({ code: "DUPLICATE", detail: `${seen.get(k) + 1} & ${i + 1}` });
    else seen.set(k, i);
  });
  const namesProduct = options.some((q) => typeof q === "string" && PRODUCT_NOUNS.some((n) => containsPhrase(q.toLowerCase(), n)));
  if (!namesProduct) setWarnings.push({ code: "NO_PRODUCT_NAMED" });
  return { perQuestion, setIssues, setWarnings };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Fresh test of deployed Bronze Snake ask-ai prompt`);
  console.log(`  Sample size: ${SAMPLE_SIZE}    concurrency: ${CONCURRENCY}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  console.log(`[1/3] Picking ${SAMPLE_SIZE} random products from Neo4j...`);
  const products = await pickRandomProducts(SAMPLE_SIZE);
  console.log(`      Got ${products.length} products`);
  fs.writeFileSync(HANDLES_DUMP, products.map((p) => p.handle).join("\n") + "\n");
  console.log(`      Handles dumped to ${HANDLES_DUMP}`);

  console.log(`\n[2/3] Regenerating via Lambda (skipCaching=true)...`);
  const results = [];
  let cursor = 0, done = 0, fail = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= products.length) return;
      const r = await regenOne(products[i]);
      results[i] = r;
      done++;
      if (r.error) {
        fail++;
        console.log(`      [${done}/${products.length}] ${r.handle}  ERR — ${r.error}`);
      } else if (done % 10 === 0 || done === products.length) {
        console.log(`      [${done}/${products.length}] done (failures so far: ${fail})`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n[3/3] Auditing the ${results.length} fresh sets...`);
  const totals = { sets: 0, hard: 0, warn: 0, clean: 0, byCode: {}, lambdaErrors: fail };
  const lines = [];

  for (const r of results) {
    if (r.error) continue;
    totals.sets++;
    const { perQuestion, setIssues, setWarnings } = checkSet(r.options);
    const hard = setIssues.concat(perQuestion.flatMap((p) => p.issues));
    const warn = setWarnings.concat(perQuestion.flatMap((p) => p.warnings));
    if (hard.length) totals.hard++;
    else if (warn.length) totals.warn++;
    else totals.clean++;
    for (const x of hard.concat(warn)) totals.byCode[x.code] = (totals.byCode[x.code] || 0) + 1;

    if (!hard.length && !warn.length && !SHOW_OK) continue;
    const status = hard.length ? "FAIL" : "WARN";
    lines.push(`\n[${status}] ${r.handle}`);
    for (const x of setIssues) lines.push(`        set: ${x.code}${x.detail ? ` — ${x.detail}` : ""}`);
    for (const x of setWarnings) lines.push(`        set: WARN ${x.code}${x.detail ? ` — ${x.detail}` : ""}`);
    r.options.forEach((q, i) => {
      const iss = perQuestion[i]?.issues || [];
      const wn = perQuestion[i]?.warnings || [];
      const tag = iss.length ? "x" : wn.length ? "?" : " ";
      lines.push(`        ${tag} ${i + 1}. ${JSON.stringify(q)}`);
      for (const x of iss) lines.push(`             - ${x.code}${x.detail ? `: ${x.detail}` : ""}`);
      for (const x of wn) lines.push(`             - WARN ${x.code}${x.detail ? `: ${x.detail}` : ""}`);
    });
  }
  console.log(lines.join("\n"));

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Summary — fresh ${STORE} userOptions`);
  console.log(`    Lambda errors:     ${totals.lambdaErrors}`);
  console.log(`    Sets audited:      ${totals.sets}`);
  console.log(`    Hard issues:       ${totals.hard}   (${pct(totals.hard, totals.sets)})`);
  console.log(`    Warnings only:     ${totals.warn}   (${pct(totals.warn, totals.sets)})`);
  console.log(`    Clean:             ${totals.clean}   (${pct(totals.clean, totals.sets)})`);
  console.log(`    Counts by code:`);
  for (const [c, n] of Object.entries(totals.byCode).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${c.padEnd(20)} ${n}`);
  }
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : "0%"; }

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("Fatal:", e); process.exit(1); });
