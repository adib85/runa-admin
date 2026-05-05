#!/usr/bin/env node
/**
 * Read-only Shopify order-count report for the last N days.
 *
 *   node apps/api/src/scripts/test-shop-sales-30d.js [shop] [days]
 *   node apps/api/src/scripts/test-shop-sales-30d.js bronze-snake-1.myshopify.com 30
 *
 * Resolves the shop's access token from the Lambda user store
 * (?action=getUser&shop=...). Set ACCESS_TOKEN env var to override.
 *
 * Why ordersCount and not the `orders` query?
 *
 * The Order GraphQL type is classified by Shopify as Protected Customer Data.
 * Public apps (like Runa) need a separate "Protected customer data access"
 * approval in the Partner Dashboard on top of the `read_orders` OAuth scope
 * before per-order details (incl. revenue) become readable. Without that
 * approval, the `orders` query returns ACCESS_DENIED.
 *
 * `ordersCount` is NOT protected — it only needs `read_orders`. It returns a
 * count + precision, supports the same search-syntax `query` filter as
 * `orders`, and is cheap (~10 cost points per call). That's enough to give
 * us "how many orders per day" without touching any customer data.
 *
 * Cost-budget guard: GraphQL is rate-limited as a leaky bucket. Each call
 * costs ~10. We make ~3 + days calls (e.g. 33 for a 30-day report) for a
 * total of ~330 cost, well within the standard 1000-point bucket and the
 * 20000-point bucket on Plus. We still read `extensions.cost.throttleStatus`
 * and sleep if the bucket would be exhausted before the next call.
 */

import { GraphQLClient, gql } from "graphql-request";

const SHOPIFY_API_VERSION = "2025-10";
const APP_SERVER_URL =
  "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const DEFAULT_SHOP = "bronze-snake-1.myshopify.com";
const DEFAULT_DAYS = 30;
const PER_QUERY_COST = 10; // ordersCount actualQueryCost we observed
const SLEEP_BUFFER_MS = 250;
const MAX_THROTTLE_RETRIES = 3;

function arg(i, fallback) {
  return process.argv[i + 2] || fallback;
}

async function getAccessToken(shop) {
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const url = `${APP_SERVER_URL}?action=getUser&shop=${encodeURIComponent(shop)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Lambda getUser failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const token = json?.data?.accessToken;
  if (!token) {
    throw new Error(`No accessToken in user record for ${shop}`);
  }
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORDERS_COUNT_QUERY = gql`
  query OrdersCount($q: String!) {
    ordersCount(query: $q, limit: null) {
      count
      precision
    }
  }
`;

async function requestWithThrottle(client, query, variables) {
  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    try {
      const res = await client.rawRequest(query, variables);
      return { data: res.data, cost: res?.extensions?.cost };
    } catch (err) {
      const errors = err?.response?.errors || [];
      const throttled = errors.some((e) => e?.extensions?.code === "THROTTLED");
      if (!throttled || attempt === MAX_THROTTLE_RETRIES) throw err;
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(`  THROTTLED — backing off ${backoff}ms (attempt ${attempt + 1})`);
      await sleep(backoff);
    }
  }
}

function maybeSleepForBudget(cost, neededForNext = PER_QUERY_COST) {
  const status = cost?.throttleStatus;
  if (!status) return 0;
  const { currentlyAvailable, restoreRate } = status;
  if (typeof currentlyAvailable !== "number" || typeof restoreRate !== "number") return 0;
  if (currentlyAvailable >= neededForNext) return 0;
  const deficit = neededForNext - currentlyAvailable;
  return Math.ceil((deficit / restoreRate) * 1000) + SLEEP_BUFFER_MS;
}

async function countOrders(client, queryString) {
  const { data, cost } = await requestWithThrottle(client, ORDERS_COUNT_QUERY, {
    q: queryString
  });
  return {
    count: data?.ordersCount?.count ?? 0,
    precision: data?.ordersCount?.precision ?? "UNKNOWN",
    cost
  };
}

function dateOnly(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const shop = arg(0, DEFAULT_SHOP);
  const days = Number.parseInt(arg(1, String(DEFAULT_DAYS)), 10);
  if (!shop || !Number.isFinite(days) || days <= 0) {
    console.error("Usage: test-shop-sales-30d.js <shop> [days]");
    process.exit(1);
  }

  const now = new Date();
  // Walk back `days` whole UTC-days. Day buckets are [start, start+24h).
  const todayStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  const sinceStart = new Date(todayStart.getTime() - (days - 1) * 24 * 3600 * 1000);
  const sinceLabel = dateOnly(sinceStart);

  console.log(`\n  Shop:   ${shop}`);
  console.log(`  Window: last ${days} days   (${sinceLabel} → today, UTC)\n`);

  const accessToken = await getAccessToken(shop);
  console.log(`  Token:  ${accessToken.slice(0, 10)}...${accessToken.slice(-4)} (read-only use)\n`);

  const client = new GraphQLClient(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      }
    }
  );

  // ── Headline numbers ──────────────────────────────────────────────────────
  console.log("──── Totals ─────────────────────────────────────────");
  const baseFilter = `created_at:>=${sinceLabel} -test:true`;

  const total = await countOrders(client, baseFilter);
  console.log(`  Orders (non-test):   ${total.count} (${total.precision})`);
  await sleep(maybeSleepForBudget(total.cost));

  const paid = await countOrders(client, `${baseFilter} financial_status:paid`);
  console.log(`  Paid:                ${paid.count} (${paid.precision})`);
  await sleep(maybeSleepForBudget(paid.cost));

  const refunded = await countOrders(client, `${baseFilter} financial_status:refunded`);
  console.log(`  Refunded:            ${refunded.count} (${refunded.precision})`);
  await sleep(maybeSleepForBudget(refunded.cost));

  const partRefunded = await countOrders(
    client,
    `${baseFilter} financial_status:partially_refunded`
  );
  console.log(`  Partially refunded:  ${partRefunded.count} (${partRefunded.precision})`);
  await sleep(maybeSleepForBudget(partRefunded.cost));

  const cancelled = await countOrders(client, `${baseFilter} status:cancelled`);
  console.log(`  Cancelled:           ${cancelled.count} (${cancelled.precision})`);
  await sleep(maybeSleepForBudget(cancelled.cost));

  // ── Daily breakdown ───────────────────────────────────────────────────────
  console.log("\n──── Per-day (UTC) ──────────────────────────────────");
  let lastCost = null;
  const rows = [];
  for (let i = 0; i < days; i++) {
    const dayStart = new Date(sinceStart.getTime() + i * 24 * 3600 * 1000);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const q = `created_at:>=${dateOnly(dayStart)} created_at:<${dateOnly(dayEnd)} -test:true`;
    const r = await countOrders(client, q);
    rows.push({ day: dateOnly(dayStart), count: r.count, precision: r.precision });
    lastCost = r.cost;
    const wait = maybeSleepForBudget(lastCost);
    if (wait > 0) await sleep(wait);
  }

  let max = 0;
  for (const r of rows) max = Math.max(max, r.count);
  for (const r of rows) {
    const bar = max > 0 ? "█".repeat(Math.round((r.count / max) * 30)) : "";
    console.log(`  ${r.day}   ${String(r.count).padStart(4)}   ${bar}`);
  }

  if (lastCost?.throttleStatus) {
    const t = lastCost.throttleStatus;
    console.log(
      `\n  bucket left: ${t.currentlyAvailable}/${t.maximumAvailable} (+${t.restoreRate}/s)`
    );
  }

  console.log(`\n  Note: revenue/AOV need Protected-Customer-Data approval in`);
  console.log(`        Partner Dashboard → Apps → Runa → API access. This script`);
  console.log(`        only uses the (non-protected) ordersCount aggregate.\n`);
}

main().catch((err) => {
  const errors = err?.response?.errors || [];
  const accessDenied = errors.find((e) => e?.extensions?.code === "ACCESS_DENIED");
  if (accessDenied) {
    console.error("\n  ✗ ACCESS_DENIED on the Order object.");
    console.error(
      "    `read_orders` is granted, but Shopify also requires the Runa app"
    );
    console.error(
      "    to be approved for Protected Customer Data Access in the Partner"
    );
    console.error(
      "    Dashboard (Apps → Runa → API access → Protected customer data)."
    );
    process.exit(2);
  }
  console.error("\nError:", err?.message || err);
  if (errors.length) {
    console.error("GraphQL errors:", JSON.stringify(errors, null, 2));
  }
  process.exit(1);
});
