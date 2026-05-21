#!/usr/bin/env node

/**
 * Bronze Snake — product addition velocity analytics (READ-ONLY).
 *
 * Fetches every product's createdAt + publishedAt from Shopify Admin and
 * aggregates by day / week / month. Useful for sizing daily sync deltas
 * and understanding catalog growth.
 *
 * Usage:
 *   node apps/api/src/scripts/bronze-product-velocity.js --token shpat_xxx
 *   node apps/api/src/scripts/bronze-product-velocity.js --token shpat_xxx --days 60
 *   node apps/api/src/scripts/bronze-product-velocity.js --token shpat_xxx --signal published
 *
 * Default signal is `created` (when the product was first created in
 * Shopify Admin). Use `--signal published` to count by publish-to-channel
 * date instead.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GraphQLClient, gql } from "graphql-request";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const args = process.argv.slice(2);
const tokenIdx = args.indexOf("--token");
const shopIdx = args.indexOf("--shop");
const daysIdx = args.indexOf("--days");
const signalIdx = args.indexOf("--signal");

const SHOP = shopIdx !== -1 ? args[shopIdx + 1] : "bronze-snake-1.myshopify.com";
const DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 30;
const SIGNAL = signalIdx !== -1 ? args[signalIdx + 1] : "created";  // "created" | "published"

if (!["created", "published"].includes(SIGNAL)) {
  console.error("--signal must be 'created' or 'published'");
  process.exit(1);
}

async function fetchToken() {
  if (tokenIdx !== -1) return args[tokenIdx + 1];
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const r = await fetch(`${APP_SERVER_URL}?action=getUser&shop=${SHOP}`);
  const j = await r.json();
  return j?.data?.accessToken;
}

function dateKey(iso, granularity) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (granularity === "day") return `${y}-${m}-${day}`;
  if (granularity === "month") return `${y}-${m}`;
  if (granularity === "week") {
    // ISO week with year — use UTC Monday-based week
    const dt = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (dt.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    dt.setUTCDate(dt.getUTCDate() - dayNum + 3); // nearest Thu
    const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return null;
}

function pad(s, n) { return String(s).padEnd(n); }
function bar(n, max, width = 30) {
  const len = Math.round((n / max) * width);
  return "█".repeat(len) + "░".repeat(width - len);
}

async function main() {
  const token = await fetchToken();
  if (!token) {
    console.error(`No token (use --token shpat_xxx, ACCESS_TOKEN env, or save to Lambda DB)`);
    process.exit(1);
  }

  const c = new GraphQLClient(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });

  const dateField = SIGNAL === "published" ? "publishedAt" : "createdAt";
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Bronze Snake — product velocity analytics`);
  console.log(`  Shop:    ${SHOP}`);
  console.log(`  Signal:  ${dateField}  (${SIGNAL === "created" ? "when created in Shopify Admin" : "when published to a sales channel"})`);
  console.log(`══════════════════════════════════════════════════════════\n`);

  // Fetch all products with date fields. status filter = active+draft to show full picture
  console.log(`Fetching products...`);
  const all = [];
  let cursor = null;
  while (true) {
    const r = await c.request(gql`
      query ($after: String) {
        products(first: 250, after: $after, query: "status:active OR status:draft OR status:archived") {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id title handle status createdAt publishedAt
          } }
        }
      }
    `, { after: cursor });
    for (const e of r.products.edges) all.push(e.node);
    if (!r.products.pageInfo.hasNextPage) break;
    cursor = r.products.pageInfo.endCursor;
    process.stdout.write(`  ${all.length}\r`);
  }
  console.log(`  ✓ Fetched ${all.length} products total\n`);

  // Status breakdown
  const byStatus = { ACTIVE: 0, DRAFT: 0, ARCHIVED: 0 };
  all.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  console.log(`Status breakdown:`);
  Object.entries(byStatus).forEach(([k, v]) => console.log(`  ${pad(k, 10)} ${v}`));
  console.log();

  // Active-only for the timeline (these are the products customers can see)
  const active = all.filter(p => p.status === "ACTIVE");
  console.log(`Active products: ${active.length}\n`);

  // First/last dates
  const dates = active.map(p => p[dateField]).filter(Boolean).sort();
  if (dates.length === 0) {
    console.log(`No ${dateField} values on active products. Try --signal ${SIGNAL === "created" ? "published" : "created"}.`);
    return;
  }
  console.log(`Date range (${dateField}): ${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}`);
  console.log(`(spans ${Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / (86400000 * 365))} years)\n`);

  // Daily — last N days
  console.log(`══════════════ DAILY (last ${DAYS} days) ══════════════\n`);
  const dailyMap = new Map();
  active.forEach(p => {
    const k = dateKey(p[dateField], "day");
    if (k) dailyMap.set(k, (dailyMap.get(k) || 0) + 1);
  });
  const today = new Date();
  const dailyKeys = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    dailyKeys.push(k);
  }
  let dailyTotal = 0;
  const dailyMax = Math.max(...dailyKeys.map(k => dailyMap.get(k) || 0)) || 1;
  for (const k of dailyKeys) {
    const n = dailyMap.get(k) || 0;
    dailyTotal += n;
    const dow = new Date(k).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" });
    console.log(`  ${k}  ${pad(dow, 4)}  ${String(n).padStart(3)}  ${bar(n, dailyMax)}`);
  }
  console.log(`\n  Total in last ${DAYS} days:  ${dailyTotal}`);
  console.log(`  Average per day:        ${(dailyTotal / DAYS).toFixed(1)}`);
  console.log(`  Days with 0 products:   ${dailyKeys.filter(k => !dailyMap.get(k)).length}`);
  console.log(`  Busiest day:            ${dailyMax} products`);

  // Weekly — last 12 weeks
  console.log(`\n══════════════ WEEKLY (last 12 weeks) ══════════════\n`);
  const weeklyMap = new Map();
  active.forEach(p => {
    const k = dateKey(p[dateField], "week");
    if (k) weeklyMap.set(k, (weeklyMap.get(k) || 0) + 1);
  });
  const weeks = [...weeklyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  const weeklyMax = Math.max(...weeks.map(([, n]) => n)) || 1;
  for (const [k, n] of weeks) {
    console.log(`  ${k}  ${String(n).padStart(4)}  ${bar(n, weeklyMax, 40)}`);
  }
  const weeklyTotal = weeks.reduce((s, [, n]) => s + n, 0);
  console.log(`\n  Total in last 12 weeks: ${weeklyTotal}`);
  console.log(`  Average per week:       ${(weeklyTotal / 12).toFixed(1)}`);

  // Monthly — last 12 months
  console.log(`\n══════════════ MONTHLY (last 12 months) ══════════════\n`);
  const monthlyMap = new Map();
  active.forEach(p => {
    const k = dateKey(p[dateField], "month");
    if (k) monthlyMap.set(k, (monthlyMap.get(k) || 0) + 1);
  });
  const months = [...monthlyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  const monthlyMax = Math.max(...months.map(([, n]) => n)) || 1;
  for (const [k, n] of months) {
    console.log(`  ${k}     ${String(n).padStart(4)}  ${bar(n, monthlyMax, 40)}`);
  }
  const monthlyTotal = months.reduce((s, [, n]) => s + n, 0);
  console.log(`\n  Total in last 12 months: ${monthlyTotal}`);
  console.log(`  Average per month:       ${(monthlyTotal / 12).toFixed(1)}`);

  // Quick summary
  console.log(`\n══════════════ DAILY SYNC IMPLICATIONS ══════════════\n`);
  const last7 = dailyKeys.slice(-7).reduce((s, k) => s + (dailyMap.get(k) || 0), 0);
  const last30 = dailyTotal;
  console.log(`  Last 7 days:    ${last7} products  (avg ${(last7 / 7).toFixed(1)}/day)`);
  console.log(`  Last 30 days:   ${last30} products  (avg ${(last30 / 30).toFixed(1)}/day)`);
  console.log(`  Recommended:    daily sync handles this load comfortably`);
  console.log(`                  estimate ~${((last7 / 7) * 0.4).toFixed(0)}–${Math.ceil((last7 / 7) * 1.5)} sec/day for delta processing\n`);
}

main().catch(e => { console.error("Error:", e.message); console.error(e.stack); process.exit(1); });
