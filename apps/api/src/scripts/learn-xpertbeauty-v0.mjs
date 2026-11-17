/**
 * XPERT BEAUTY — learning v0 (nightly).
 *
 * Reads the structured `xb_track` lines the Lambda logs (action=track: bundle_shown / bundle_accepted /
 * bundle_dismissed / ritual_shown / ritual_click) from CloudWatch Logs Insights for the last N days,
 * aggregates acceptance per (routine, category), and writes a bounded boost on the COMPLEMENTS edges:
 *
 *   accept rate of a category within a routine vs. the routine's mean  →  l.learnedBoost ∈ [-0.3, +0.3]
 *   (needs ≥ MIN_SHOWN impressions; otherwise the edge keeps 0 — the ontology rank decides)
 *
 * getComplements adds `coalesce(l.learnedBoost, 0)` to the candidate score, so a category that shoppers
 * accept more often climbs within its step; nothing is ever removed and the prompt-v1 default is untouched.
 *
 *   node src/scripts/learn-xpertbeauty-v0.mjs [--days 14] [--dry-run]
 *   env: XB_LOG_GROUP (default /aws/lambda/openai-serverless-production-xpertBeautyChat), AWS creds with logs:StartQuery
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");

const STORE = "xpertbeauty.ro";
const LOG_GROUP = process.env.XB_LOG_GROUP || "/aws/lambda/openai-serverless-production-xpertBeautyChat";
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf("--days") + 1] || 14);
const DRY = args.includes("--dry-run");
const MIN_SHOWN = 20, MAX_BOOST = 0.3;

function insights(query, days) {
  const end = Math.floor(Date.now() / 1000), start = end - days * 86400;
  const aws = (a) => JSON.parse(execFileSync("aws", [...a, "--region", "us-east-1", "--output", "json"], { encoding: "utf8" }));
  const { queryId } = aws(["logs", "start-query", "--log-group-name", LOG_GROUP, "--start-time", String(start), "--end-time", String(end), "--query-string", query]);
  for (let i = 0; i < 60; i++) {
    const r = aws(["logs", "get-query-results", "--query-id", queryId]);
    if (r.status === "Complete") return r.results.map((row) => Object.fromEntries(row.map((f) => [f.field, f.value])));
    if (["Failed", "Cancelled", "Timeout"].includes(r.status)) throw new Error(`Insights ${r.status}`);
    execFileSync("sleep", ["2"]);
  }
  throw new Error("Insights timeout");
}

// impressions + acceptances per routine → per category (bundle_shown carries itemIds; we resolve categories in Neo4j)
const rows = insights(`fields @message | filter @message like /"evt":"xb_track"/ | parse @message '"event":"*"' as event | parse @message '"routine":"*"' as routine | parse @message '"itemIds":[*]' as items | filter event in ["bundle_shown","bundle_accepted","ritual_shown","ritual_click"] | stats count() as n by event, routine, items`, DAYS);
console.log(`[learn] ${rows.length} aggregated rows over ${DAYS} days from ${LOG_GROUP}`);
const idsOf = (s) => String(s || "").split(",").map((x) => x.replace(/["\s]/g, "")).filter(Boolean);

const driver = new Neo4jService().getDriver();
const s = driver.session();
try {
  const allIds = [...new Set(rows.flatMap((r) => idsOf(r.items)))];
  const cat = new Map((await s.run(`MATCH (p:Product {storeId:$s}) WHERE p.id IN $ids RETURN p.id AS id, p.category AS c`, { s: STORE, ids: allIds })).records.map((x) => [x.get("id"), x.get("c")]));
  // per (routine, category): shown vs accepted (bundle) — ritual_click counts as an acceptance of that item's category
  const agg = new Map(); const key = (r, c) => `${r}||${c}`;
  for (const r of rows) {
    const n = Number(r.n || 0), rt = r.routine || "unknown";
    for (const id of idsOf(r.items)) {
      const c = cat.get(id); if (!c) continue;
      const a = agg.get(key(rt, c)) || { routine: rt, category: c, shown: 0, accepted: 0 };
      if (r.event === "bundle_shown" || r.event === "ritual_shown") a.shown += n; else a.accepted += n;
      agg.set(key(rt, c), a);
    }
  }
  const byRoutine = new Map();
  for (const a of agg.values()) { const l = byRoutine.get(a.routine) || []; l.push(a); byRoutine.set(a.routine, l); }
  const updates = [];
  for (const [rt, list] of byRoutine) {
    const eligible = list.filter((a) => a.shown >= MIN_SHOWN); if (!eligible.length) continue;
    const mean = eligible.reduce((t, a) => t + a.accepted / a.shown, 0) / eligible.length;
    for (const a of eligible) {
      const rate = a.accepted / a.shown;
      const boost = Math.max(-MAX_BOOST, Math.min(MAX_BOOST, (rate - mean) * 2)); // ±15 pp around the mean saturates
      updates.push({ routine: rt, category: a.category, shown: a.shown, accepted: a.accepted, rate: +rate.toFixed(3), boost: +boost.toFixed(3) });
    }
  }
  console.table(updates);
  if (!DRY && updates.length) {
    const r = await s.run(`UNWIND $u AS u
      MATCH (rt:Routine {storeId:$s, key:u.routine})-[:HAS_STEP]->(:RoutineStep)-[l:COMPLEMENTS]->(c:Category {storeId:$s, name:u.category})
      SET l.learnedBoost = u.boost, l.learnedShown = u.shown, l.learnedAccepted = u.accepted, l.learnedAt = datetime()
      RETURN count(l) AS edges`, { s: STORE, u: updates });
    console.log(`[learn] wrote learnedBoost on ${Number(r.records[0].get("edges"))} COMPLEMENTS edges`);
  } else console.log(DRY ? "[learn] dry-run: nothing written" : "[learn] nothing eligible yet (need ≥ 20 impressions per routine/category)");
} finally { await s.close(); await driver.close(); }
