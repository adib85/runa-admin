#!/usr/bin/env node

/**
 * Audit Bronze Snake ask-ai userOptions against the Contemporary Style
 * Curator prompt rules.
 *
 * Reads every `<storeId>_userOptions_<handle>_en` cache item from
 * DynamoDB and validates each set of 3 chips against the prompt:
 *
 *   • Hard violations (the generator broke a rule)
 *     - not exactly 3 questions
 *     - empty / non-string entry
 *     - question > 55 characters
 *     - second-person voice ("you" / "your")
 *     - occasion / context wording (office, wedding, dinner, brunch,
 *       weekend, evening, day, summer, winter, holiday, "day to night",
 *       …) — the most important class to catch per the request
 *     - forbidden vocabulary (cheap, bargain, basic, generic, …)
 *     - non-hero-anchored ("this piece" / "this item" / "this product")
 *     - singular/plural mismatch for inherently-plural items
 *       (this jeans, this pants, …)
 *
 *   • Soft warnings (worth a human look)
 *     - too vague / restates the CTL widget
 *       ("what does it pair with", "matching products", …)
 *     - no product type named in any of the 3 chips
 *     - duplicate questions inside the same set
 *
 * Read-only. Touches DynamoDB only.
 *
 * Usage:
 *   node apps/api/src/scripts/audit-bronzesnake-user-options-quality.mjs
 *     [--handle <handle>]   audit a single product
 *     [--limit <n>]         cap how many cache items to inspect
 *     [--only-bad]          only print products with at least one issue
 *     [--show-ok]           also print the chips for clean products
 *     [--json]              emit machine-readable JSON instead of text
 *     [--language <code>]   cache language suffix (default: en)
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import AWS from "aws-sdk";

AWS.config.update({ region: process.env.AWS_REGION || "us-east-1" });
const ddb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

const TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const STORE = "bronze-snake-1.myshopify.com";

// ─── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : d;
};

const SINGLE_HANDLE = opt("handle");
const LIMIT = opt("limit") ? parseInt(opt("limit"), 10) : null;
const ONLY_BAD = flag("only-bad");
const SHOW_OK = flag("show-ok");
const JSON_OUT = flag("json");
const LANGUAGE = opt("language", "en");

// ─── Rule definitions ────────────────────────────────────────────────

const MAX_CHARS = 55;

// "Out of scope" terms from the prompt — occasion, setting, season, time of day.
// Word-boundary matched. Lowercased input.
const OCCASION_WORDS = [
  // settings / formality-via-setting
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
  // time of day
  "daytime", "day to night", "day-to-night",
  "evening", "evenings", "nighttime", "night out",
  "morning", "afternoon",
  // seasons
  "summer", "winter", "spring", "autumn", "fall",
  // dress-code framings
  "smart casual", "smart-casual", "business casual", "business-casual",
  "formal occasion", "formal occasions",
  "office-appropriate", "office appropriate",
  "occasion", "occasions",
];

const FORBIDDEN_VOCAB = [
  "cheap", "affordable", "bargain", "deal",
  "basic", "fast fashion", "hype", "copycat", "generic", "mass-produced",
  "mass produced",
  // "sale" is allowed only when explicitly about Sale; flag bare uses.
  "on sale", "sale price",
];

const VAGUE_PHRASES = [
  "this piece", "this item", "this product", "this thing",
];

const RESTATES_CTL = [
  "matching products", "matching product",
  "what does it pair with", "what does this pair with",
  "what goes with this", "what goes with it",
];

// Inherently-plural product nouns — should appear with "these", not "this".
const PLURAL_NOUNS = ["jeans", "pants", "trousers", "shorts", "leggings", "joggers", "tights", "sunglasses", "earrings"];

// Heuristic list of product-type nouns we expect at least one chip to name.
// Used only for the soft "no product type named" warning.
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

// ─── Per-question check ──────────────────────────────────────────────

function checkQuestion(q) {
  const issues = [];
  const warnings = [];

  if (typeof q !== "string") {
    issues.push({ code: "NOT_STRING", detail: `value is ${typeof q}` });
    return { issues, warnings };
  }

  const trimmed = q.trim();
  if (!trimmed) {
    issues.push({ code: "EMPTY" });
    return { issues, warnings };
  }

  if (trimmed.length > MAX_CHARS) {
    issues.push({ code: "TOO_LONG", detail: `${trimmed.length} > ${MAX_CHARS} chars` });
  }

  const lc = trimmed.toLowerCase();

  // Second-person "you" / "your" / "you're" / "yours"
  if (/\byou\b|\byour\b|\byou're\b|\byours\b/i.test(trimmed)) {
    issues.push({ code: "SECOND_PERSON", detail: `uses "you" / "your"` });
  }

  // Occasion / setting / season / time-of-day
  const occHits = OCCASION_WORDS.filter((w) => containsPhrase(lc, w));
  if (occHits.length) {
    issues.push({ code: "OCCASION", detail: `flagged terms: ${occHits.join(", ")}` });
  }

  // Forbidden vocab
  const vocHits = FORBIDDEN_VOCAB.filter((w) => containsPhrase(lc, w));
  if (vocHits.length) {
    issues.push({ code: "FORBIDDEN_VOCAB", detail: `terms: ${vocHits.join(", ")}` });
  }

  // Vague / non-hero-anchored
  const vagueHits = VAGUE_PHRASES.filter((p) => lc.includes(p));
  if (vagueHits.length) {
    issues.push({ code: "VAGUE", detail: `phrases: ${vagueHits.join(", ")}` });
  }

  // Singular/plural mismatch: "this jeans" instead of "these jeans"
  for (const noun of PLURAL_NOUNS) {
    const re = new RegExp(`\\bthis\\s+${noun}\\b`, "i");
    if (re.test(trimmed)) {
      issues.push({ code: "GRAMMAR_PLURAL", detail: `"this ${noun}" — use "these ${noun}"` });
    }
  }

  // Soft: too vague / restates CTL widget
  const ctlHits = RESTATES_CTL.filter((p) => lc.includes(p));
  if (ctlHits.length) {
    warnings.push({ code: "RESTATES_CTL", detail: `phrases: ${ctlHits.join(", ")}` });
  }

  return { issues, warnings };
}

function containsPhrase(haystackLc, needle) {
  // Word-boundary match for single words; substring for multi-word phrases
  // (\b doesn't play nicely across hyphens / spaces in JS regex for phrases
  // like "smart-casual").
  if (/\s|-/.test(needle)) {
    return haystackLc.includes(needle);
  }
  const re = new RegExp(`\\b${escapeReg(needle)}\\b`, "i");
  return re.test(haystackLc);
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Per-set check ───────────────────────────────────────────────────

function checkSet(options) {
  const setIssues = [];
  const setWarnings = [];

  if (!Array.isArray(options)) {
    setIssues.push({ code: "NOT_ARRAY" });
    return { perQuestion: [], setIssues, setWarnings };
  }
  if (options.length !== 3) {
    setIssues.push({ code: "WRONG_COUNT", detail: `${options.length} questions (expected 3)` });
  }

  const perQuestion = options.map(checkQuestion);

  // Duplicate questions inside the set
  const seen = new Map();
  options.forEach((q, i) => {
    if (typeof q !== "string") return;
    const k = q.trim().toLowerCase();
    if (!k) return;
    if (seen.has(k)) {
      setIssues.push({ code: "DUPLICATE", detail: `chips ${seen.get(k) + 1} and ${i + 1} are identical` });
    } else {
      seen.set(k, i);
    }
  });

  // At least one chip should name a product type
  const namesProduct = options.some(
    (q) => typeof q === "string" && PRODUCT_NOUNS.some((n) => containsPhrase(q.toLowerCase(), n))
  );
  if (!namesProduct) {
    setWarnings.push({ code: "NO_PRODUCT_NAMED", detail: "no chip names a product type (jacket, jeans, …)" });
  }

  return { perQuestion, setIssues, setWarnings };
}

// ─── DynamoDB scan ───────────────────────────────────────────────────

async function fetchOne(handle) {
  const id = `${STORE}_userOptions_${handle.toLowerCase()}_${LANGUAGE}`;
  const r = await ddb.get({ TableName: TABLE, Key: { id } }).promise();
  return r.Item ? [r.Item] : [];
}

async function scanAll() {
  const items = [];
  let lastKey;
  const marker = `_userOptions_`;
  do {
    const r = await ddb.query({
      TableName: TABLE,
      IndexName: "storeId-index",
      KeyConditionExpression: "storeId = :s",
      ExpressionAttributeValues: { ":s": STORE },
      ExclusiveStartKey: lastKey,
      Limit: 200,
    }).promise();
    for (const it of r.Items || []) {
      const id = String(it.id || "");
      if (!id.includes(marker)) continue;
      if (!id.endsWith(`_${LANGUAGE}`)) continue;
      items.push(it);
      if (LIMIT && items.length >= LIMIT) return items;
    }
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function handleFromId(id) {
  // id is `<storeId>_userOptions_<handle>_<lang>`
  const prefix = `${STORE}_userOptions_`;
  const suffix = `_${LANGUAGE}`;
  if (!id.startsWith(prefix) || !id.endsWith(suffix)) return id;
  return id.slice(prefix.length, id.length - suffix.length);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const items = SINGLE_HANDLE ? await fetchOne(SINGLE_HANDLE) : await scanAll();

  if (!items.length) {
    console.log(SINGLE_HANDLE
      ? `No cache item for handle "${SINGLE_HANDLE}".`
      : `No userOptions cache items found for ${STORE}.`);
    return;
  }

  const report = [];
  const totals = {
    sets: 0,
    setsWithIssues: 0,
    setsWithWarnings: 0,
    clean: 0,
    byCode: {},
  };

  for (const it of items) {
    const handle = handleFromId(String(it.id));
    const rawOptions = it.data?.userOptions ?? it.userOptions;
    const { perQuestion, setIssues, setWarnings } = checkSet(rawOptions);

    const flatIssues = setIssues.concat(perQuestion.flatMap((p) => p.issues));
    const flatWarnings = setWarnings.concat(perQuestion.flatMap((p) => p.warnings));

    totals.sets++;
    if (flatIssues.length) totals.setsWithIssues++;
    if (flatWarnings.length) totals.setsWithWarnings++;
    if (!flatIssues.length && !flatWarnings.length) totals.clean++;
    for (const i of flatIssues) totals.byCode[i.code] = (totals.byCode[i.code] || 0) + 1;
    for (const w of flatWarnings) totals.byCode[w.code] = (totals.byCode[w.code] || 0) + 1;

    report.push({ handle, options: Array.isArray(rawOptions) ? rawOptions : null, perQuestion, setIssues, setWarnings });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ totals, report }, null, 2));
    return;
  }

  // Pretty text report
  for (const r of report) {
    const hasIssue = r.setIssues.length || r.perQuestion.some((p) => p.issues.length);
    const hasWarn = r.setWarnings.length || r.perQuestion.some((p) => p.warnings.length);
    if (ONLY_BAD && !hasIssue && !hasWarn) continue;
    if (!hasIssue && !hasWarn && !SHOW_OK) continue;

    const status = hasIssue ? "FAIL" : hasWarn ? "WARN" : "OK  ";
    console.log(`\n[${status}] ${r.handle}`);
    if (!Array.isArray(r.options)) {
      console.log(`        userOptions is not an array (got ${typeof r.options})`);
      continue;
    }
    for (const si of r.setIssues) console.log(`        set: ${si.code}${si.detail ? ` — ${si.detail}` : ""}`);
    for (const sw of r.setWarnings) console.log(`        set: WARN ${sw.code}${sw.detail ? ` — ${sw.detail}` : ""}`);
    r.options.forEach((q, i) => {
      const issues = r.perQuestion[i]?.issues || [];
      const warns = r.perQuestion[i]?.warnings || [];
      const tag = issues.length ? "x" : warns.length ? "?" : " ";
      console.log(`        ${tag} ${i + 1}. ${JSON.stringify(q)}`);
      for (const is of issues) console.log(`             - ${is.code}${is.detail ? `: ${is.detail}` : ""}`);
      for (const wn of warns) console.log(`             - WARN ${wn.code}${wn.detail ? `: ${wn.detail}` : ""}`);
    });
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Audit summary — ${STORE} userOptions (lang=${LANGUAGE})`);
  console.log(`    Sets scanned:        ${totals.sets}`);
  console.log(`    With hard issues:    ${totals.setsWithIssues}`);
  console.log(`    With warnings only:  ${totals.setsWithWarnings - Math.min(totals.setsWithWarnings, totals.setsWithIssues)}`);
  console.log(`    Clean:               ${totals.clean}`);
  console.log(`    Counts by code:`);
  for (const [code, n] of Object.entries(totals.byCode).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${code.padEnd(20)} ${n}`);
  }
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
