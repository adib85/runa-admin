#!/usr/bin/env node
/**
 * Refresh stale "How to style it" bundles on Amalin's product pages (amalin.com = andreearaicu.myshopify.com).
 *
 * The PDP widget Lambdas (runa_serverless handlerChatGPT4FuncDefaultAR / DefaultCategoryAR) cache one answer per
 * product + language (+ profile) in DynamoDB CacheTable and keep it until the store's UserTable contextUpdatetAt
 * changes. The nightly catalog sync does not touch that cache, so a bundle could keep recommending a product that
 * sold out or left the shop, for months.
 *
 * Runs after the nightly sync (sync-amalin-all.sh step 3). A cached bundle is marked stale when
 *   - it recommends a product that is now sold out (Product.inStock = false), or
 *   - it recommends a product that is no longer in the catalog (not in Neo4j for this store), or
 *   - it is older than --max-age-days (default 30).
 * "Marked stale" = its contextUpdatetAt is set to 0 (conditional on the value read), the same signal the
 * Lambda uses when the store's instructions change: on the next view it deletes the entry and builds a new
 * bundle. Nothing is deleted here, and bundles nobody views cost nothing.
 *
 * Usage:
 *   node apps/api/src/scripts/refresh-amalin-bundles.mjs --dry-run     # list what would be refreshed
 *   node apps/api/src/scripts/refresh-amalin-bundles.mjs               # mark them stale
 *   options: --shop <myshopify domain>  --max-age-days <n>  --limit <n> / --only <cache id> (testing)
 */
import AWS from "aws-sdk";
import neo4j from "neo4j-driver";
import { AWS_REGION, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } from "../sync/services/config.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SHOP = opt("--shop", "andreearaicu.myshopify.com");
const MAX_AGE_DAYS = Number(opt("--max-age-days", "30"));
const DRY_RUN = flag("--dry-run");
const LIMIT = Number(opt("--limit", "0")) || Infinity;   // mark at most N (testing)
const ONLY = opt("--only", null);                         // one cache id (testing)
const DAY_MS = 24 * 60 * 60 * 1000;

AWS.config.update({ region: AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

async function cachedBundles(shop) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.query({
      TableName: "CacheTable",
      IndexName: "storeId-index",
      KeyConditionExpression: "storeId = :s",
      ExpressionAttributeValues: { ":s": shop },
      ExclusiveStartKey,
    }).promise();
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Recommended products of a cached answer: data.products[].items[] (handle; "id" there is only a position).
function recommendedHandles(entry) {
  const groups = entry && entry.data && Array.isArray(entry.data.products) ? entry.data.products : [];
  const out = new Set();
  groups.forEach((g) => (Array.isArray(g && g.items) ? g.items : []).forEach((it) => {
    if (it && it.handle) out.add(String(it.handle).toLowerCase());
  }));
  return [...out];
}

async function catalogStatus(shop, handles) {
  if (!handles.length) return new Map();
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(
      `MATCH (p:Product {storeId: $shop}) WHERE toLower(p.handle) IN $handles
       RETURN toLower(p.handle) AS handle, coalesce(p.inStock, true) AS inStock`,
      { shop, handles },
    );
    const m = new Map();
    // a handle can exist on more than one node (legacy duplicates): in stock if any copy is
    res.records.forEach((r) => m.set(r.get("handle"), (m.get(r.get("handle")) || false) || r.get("inStock")));
    return m;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function storeContextUpdatetAt(shop) {
  const r = await ddb.query({
    TableName: "UserTable",
    IndexName: "shop_index",
    KeyConditionExpression: "shop = :s",
    ExpressionAttributeValues: { ":s": shop },
    ProjectionExpression: "id, contextUpdatetAt",
  }).promise();
  const u = (r.Items || [])[0];
  return u ? u.contextUpdatetAt : null;
}

async function main() {
  const started = Date.now();
  console.log(`=== refresh-amalin-bundles ${new Date().toISOString()} shop=${SHOP} maxAge=${MAX_AGE_DAYS}d ${DRY_RUN ? "DRY RUN" : ""}`);
  const [entries, storeCtx] = await Promise.all([cachedBundles(SHOP), storeContextUpdatetAt(SHOP)]);
  const allHandles = [...new Set(entries.flatMap(recommendedHandles))];
  const status = await catalogStatus(SHOP, allHandles);
  const now = Date.now();

  const counts = { entries: entries.length, alreadyStale: 0, ok: 0, soldOut: 0, removed: 0, tooOld: 0, marked: 0, raced: 0 };
  const examples = [];
  for (const e of entries) {
    if (ONLY && e.id !== ONLY) continue;
    // Already invalid for the Lambda (instructions changed since, or marked before): it rebuilds anyway.
    if (!e.contextUpdatetAt || (storeCtx != null && e.contextUpdatetAt !== storeCtx)) { counts.alreadyStale += 1; continue; }
    const handles = recommendedHandles(e);
    const soldOut = handles.filter((h) => status.has(h) && status.get(h) === false);
    const removed = handles.filter((h) => !status.has(h));
    const tooOld = e.createdAt && now - Number(e.createdAt) > MAX_AGE_DAYS * DAY_MS;
    const reasons = [];
    if (soldOut.length) { reasons.push(`sold out: ${soldOut.join(", ")}`); counts.soldOut += 1; }
    if (removed.length) { reasons.push(`removed: ${removed.join(", ")}`); counts.removed += 1; }
    if (tooOld) { reasons.push(`older than ${MAX_AGE_DAYS} days`); counts.tooOld += 1; }
    if (!reasons.length) { counts.ok += 1; continue; }
    if (examples.length < 25) examples.push(`  ${e.id}  →  ${reasons.join(" | ")}`);
    if (DRY_RUN || counts.marked >= LIMIT) continue;
    try {
      await ddb.update({
        TableName: "CacheTable",
        Key: { id: e.id },
        UpdateExpression: "SET contextUpdatetAt = :zero, staleReason = :why, staleMarkedAt = :now",
        ConditionExpression: "contextUpdatetAt = :seen",
        ExpressionAttributeValues: { ":zero": 0, ":why": reasons.join(" | ").slice(0, 500), ":now": now, ":seen": e.contextUpdatetAt },
      }).promise();
      counts.marked += 1;
    } catch (err) {
      if (err && err.code === "ConditionalCheckFailedException") counts.raced += 1; // rebuilt meanwhile
      else throw err;
    }
  }

  examples.forEach((l) => console.log(l));
  if (counts.soldOut + counts.removed + counts.tooOld > examples.length) console.log("  …");
  console.log(`cached bundles: ${counts.entries} | already being rebuilt: ${counts.alreadyStale} | fine: ${counts.ok}` +
    ` | with a sold-out product: ${counts.soldOut} | with a removed product: ${counts.removed} | older than ${MAX_AGE_DAYS}d: ${counts.tooOld}` +
    (DRY_RUN ? " | DRY RUN: nothing changed" : ` | marked for rebuild: ${counts.marked}${counts.raced ? ` (${counts.raced} rebuilt meanwhile)` : ""}`));
  console.log(`✓ done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error("refresh-amalin-bundles failed:", e && e.message ? e.message : e);
  process.exit(1);
});
