#!/usr/bin/env node
/**
 * Quicklly catalog health check — the guard that was missing.
 * ─────────────────────────────────────────────────────────────────────────────
 * In Aug 2026 Quicklly hardened their ajax layer. Our crawler kept exiting 0 while
 * writing nothing, and the catalog sat frozen for ~3 weeks until their QA noticed
 * stale prices. Nothing watched for that. This does.
 *
 * Six checks, run against Neo4j + their live sitemap:
 *   1. STALE      — products not refreshed in FRESH_DAYS days (the silent-outage signal)
 *   2. EMPTY      — indexed stores holding zero products
 *   3. SHRUNK     — stores that lost a big slice of their catalog since the last run
 *   4. TOTAL      — whole-catalog drop since the last run
 *   5. UNSERVED   — :Location nodes no store delivers to
 *   6. NEW STORES — merchants live on Quicklly that we have never indexed
 *
 * Each run writes a snapshot to logs/quicklly-health-latest.json; checks 3 and 4
 * diff against the previous one, so the first run only establishes a baseline.
 *
 * Exit code is 1 when any check is CRITICAL, so cron/CI treats it as a failure.
 *
 * Usage:
 *   node apps/api/src/scripts/quicklly-health-check.mjs
 *   node apps/api/src/scripts/quicklly-health-check.mjs --json     # machine-readable only
 *   node apps/api/src/scripts/quicklly-health-check.mjs --no-remote  # skip the sitemap fetch
 *
 * Alerting (all optional — with none configured it still prints and exits non-zero):
 *   QUICKLLY_ALERT_WEBHOOK   Slack/Discord-compatible incoming webhook
 *   QUICKLLY_ALERT_EMAIL_TO  comma-separated recipients
 *   QUICKLLY_ALERT_EMAIL_FROM  the sender — a SendGrid-verified one (noreply@modapp.me, the
 *                              address the platform already mails from) when SENDGRID_API_KEY
 *                              is set, else an SES-verified one (SES creds via the instance)
 *   SENDGRID_API_KEY         SendGrid key → email goes out over their HTTPS API, no SDK needed
 *   --test-alert             send a test email/webhook now and exit (verifies the channel)
 *
 * Thresholds (env-overridable):
 *   QUICKLLY_FRESH_DAYS        default 3   — a daily sync gives itself 3 days of slack
 *   QUICKLLY_SHRINK_PCT        default 30  — per-store catalog loss that is suspicious
 *   QUICKLLY_TOTAL_DROP_PCT    default 10  — whole-catalog loss that is suspicious
 */
import neo4j from "neo4j-driver";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const LOG_DIR = path.join(REPO, "logs");
const SNAPSHOT = path.join(LOG_DIR, "quicklly-health-latest.json");
const SNAPSHOT_PREV = path.join(LOG_DIR, "quicklly-health-verdict.json");   // last run's verdict, for "new warning" / "recovered" mails

const args = process.argv.slice(2);
const JSON_ONLY = args.includes("--json");
const NO_REMOTE = args.includes("--no-remote");

const FRESH_DAYS = Number(process.env.QUICKLLY_FRESH_DAYS || 3);
const SHRINK_PCT = Number(process.env.QUICKLLY_SHRINK_PCT || 30);
const TOTAL_DROP_PCT = Number(process.env.QUICKLLY_TOTAL_DROP_PCT || 10);

// ── env ──────────────────────────────────────────────────────────────────────
const env = { ...process.env };
for (const f of [path.join(REPO, ".env")]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (env[k] === undefined) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const say = (...a) => { if (!JSON_ONLY) console.log(...a); };

if (process.argv.includes("--test-alert")) {
  await alert("Quicklly catalog health — test alert", `Test alert from ${os.hostname()} at ${new Date().toISOString()}.\nIf you can read this, the health-check alert channel works.`);
  process.exit(0);
}
const num = (v) => (v && typeof v.toNumber === "function" ? v.toNumber() : Number(v || 0));

// ── checks ───────────────────────────────────────────────────────────────────
const findings = [];   // { level: "CRITICAL"|"WARN"|"OK", check, message, detail }
const add = (level, check, message, detail) => findings.push({ level, check, message, detail });

const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const session = driver.session();

let snapshot;
try {
  // Per-store counts + the newest product timestamp we hold for each.
  // Freshness is max(lastSeenAt), NOT max(updated_at): stampSeen refreshes lastSeenAt (and price)
  // on every product the crawl sees without rewriting it, while updated_at only moves when a
  // product is (re)embedded. After the first complete crawl most stores have no new products on a
  // given night, so updated_at would flag the whole catalogue stale while it is perfectly fresh.
  // Retired stores (stamped by the directory's retire-dead pass) are not the sync's job any more
  // and are left out entirely — a dead store with zero products is expected, not critical.
  const res = await session.run(`
    MATCH (s:Store) WHERE s.id STARTS WITH 'quicklly_' AND s.retiredAt IS NULL
    OPTIONAL MATCH (s)-[:HAS_PRODUCT]->(p:Product)
    RETURN s.id AS store, count(p) AS products, max(coalesce(p.lastSeenAt, p.updated_at)) AS newest
    ORDER BY store
  `);
  const stores = res.records.map((r) => ({
    store: r.get("store"),
    products: num(r.get("products")),
    newest: r.get("newest") || null,
  }));
  const total = stores.reduce((a, s) => a + s.products, 0);

  const newestOverall = stores.map((s) => s.newest).filter(Boolean).sort().pop() || null;
  snapshot = { ranAt: new Date().toISOString(), total, newestOverall, stores };

  // 1. STALE — the signal that would have caught the Aug outage on day 4.
  //    Deliberately PER STORE: a single healthy store's timestamp would otherwise mask
  //    75 dead ones, which is precisely how the August outage stayed invisible.
  const ageOf = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Infinity);
  const stocked = stores.filter((s) => s.products > 0);
  snapshot.retiredStores = num((await session.run(`MATCH (s:Store) WHERE s.id STARTS WITH 'quicklly_' AND s.retiredAt IS NOT NULL RETURN count(s) AS n`)).records[0].get("n"));
  const stale = stocked
    .map((s) => ({ ...s, age: ageOf(s.newest) }))
    .filter((s) => s.age > FRESH_DAYS)
    .sort((a, b) => b.age - a.age);
  const stalePct = stocked.length ? (stale.length / stocked.length) * 100 : 0;
  const staleDetail = stale.map((s) =>
    `${s.store}: ${Number.isFinite(s.age) ? `${s.age.toFixed(1)}d stale` : "never written"}`);
  if (stalePct >= 20) {
    add("CRITICAL", "STALE",
      `${stale.length}/${stocked.length} stores (${stalePct.toFixed(0)}%) not refreshed in ${FRESH_DAYS}d.`,
      staleDetail);
  } else if (stale.length) {
    add("WARN", "STALE", `${stale.length}/${stocked.length} store(s) not refreshed in ${FRESH_DAYS}d.`, staleDetail);
  } else {
    add("OK", "STALE", `All ${stocked.length} stocked stores refreshed within ${FRESH_DAYS}d (newest ${ageOf(newestOverall).toFixed(1)}d ago).`);
  }

  // 2. EMPTY stores
  const empty = stores.filter((s) => s.products === 0).map((s) => s.store);
  if (empty.length) add("CRITICAL", "EMPTY", `${empty.length} indexed store(s) hold zero products.`, empty);
  else add("OK", "EMPTY", "Every indexed store holds products.");

  // 3/4. Regression vs the previous snapshot.
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")); } catch {}
  if (!prev) {
    add("OK", "REGRESSION", "No previous snapshot — baseline established, diffing starts next run.");
  } else {
    const prevByStore = new Map(prev.stores.map((s) => [s.store, s.products]));
    const shrunk = [];
    for (const s of stores) {
      const before = prevByStore.get(s.store);
      if (!before) continue;
      const lostPct = ((before - s.products) / before) * 100;
      if (lostPct >= SHRINK_PCT) shrunk.push(`${s.store}: ${before} → ${s.products} (-${lostPct.toFixed(0)}%)`);
    }
    if (shrunk.length) add("CRITICAL", "SHRUNK", `${shrunk.length} store(s) lost ≥${SHRINK_PCT}% of their catalog.`, shrunk);
    else add("OK", "SHRUNK", "No store shrank materially.");

    const totalDropPct = prev.total ? ((prev.total - total) / prev.total) * 100 : 0;
    if (totalDropPct >= TOTAL_DROP_PCT) {
      add("CRITICAL", "TOTAL", `Catalog dropped ${totalDropPct.toFixed(1)}%: ${prev.total} → ${total} products.`);
    } else {
      add("OK", "TOTAL", `Catalog total ${total} (was ${prev.total}).`);
    }
  }

  // 5. Locations nothing delivers to — a shopper there gets an empty assistant.
  const unserved = await session.run(`
    MATCH (l:Location) WHERE NOT (l)<-[:DELIVERS_TO]-(:Store)
    RETURN collect(l.slug) AS slugs
  `);
  const slugs = (unserved.records[0]?.get("slugs") || []).filter(Boolean);
  if (slugs.length) add("WARN", "UNSERVED", `${slugs.length} location(s) have no delivering store.`, slugs.slice(0, 40));
  else add("OK", "UNSERVED", "Every location has at least one delivering store.");

  snapshot.unserved = slugs.length;

  // 6. Merchants live on Quicklly that we have never indexed (catches new stores).
  if (!NO_REMOTE) {
    const live = await liveMerchantSlugs();
    if (!live) {
      add("WARN", "NEW_STORES", "Could not read Quicklly's sitemap — skipped the new-store diff.");
    } else {
      const ours = new Set(stores.map((s) => s.store.replace(/^quicklly_/, "")));
      const missing = [...live].filter((m) => !ours.has(m)).sort();
      snapshot.liveMerchants = live.size;
      snapshot.missingMerchants = missing;
      if (missing.length) add("WARN", "NEW_STORES", `${missing.length} merchant(s) live on Quicklly are not indexed.`, missing);
      else add("OK", "NEW_STORES", `All ${live.size} sitemap merchants are indexed.`);
    }
  }
} finally {
  await session.close();
  await driver.close();
}

// Live merchants: the near-me directory when we have a fresh one (it is what shoppers see and
// it disagrees with the sitemap in both directions), else the sitemap as before.
async function liveMerchantSlugs() {
  try {
    const dirPath = path.join(process.env.QUICKLLY_CACHE_ROOT || path.join(REPO, ".quicklly-cache"), "directory.json");
    const dir = JSON.parse(fs.readFileSync(dirPath, "utf8"));
    if (dir?.stores && Date.now() - Date.parse(dir.builtAt) < 48 * 3600 * 1000) {
      return new Set(Object.entries(dir.stores).filter(([, s]) => s.storeId).map(([slug]) => slug));
    }
  } catch {}
  return sitemapMerchantSlugs();
}
async function sitemapMerchantSlugs() {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const ORIGIN = "https://www.quicklly.com";
  const get = async (u) => {
    for (let a = 0; a < 3; a++) {
      try { const r = await fetch(u, { headers: { "User-Agent": UA } }); if (r.ok) return await r.text(); } catch {}
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
    }
    return "";
  };
  const locsOf = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim());
  const seen = new Set();
  const queue = [`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap_prod.xml`];
  const merchants = new Set();
  while (queue.length) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    const xml = await get(u);
    if (!xml) continue;
    if (/<sitemapindex/i.test(xml)) { for (const c of locsOf(xml)) queue.push(c); continue; }
    for (const url of locsOf(xml)) {
      let parts;
      try { parts = new URL(url).pathname.replace(/^\/|\/$/g, "").split("/"); } catch { continue; }
      if (parts[0] === "indian-grocery" && parts.length === 4) merchants.add(parts[2]);
      if (parts[0] === "indian-grocery-store" && parts.length >= 3) merchants.add(parts[2]);
    }
  }
  return merchants.size ? merchants : null;
}

// ── report ───────────────────────────────────────────────────────────────────
const critical = findings.filter((f) => f.level === "CRITICAL");
const warn = findings.filter((f) => f.level === "WARN");

const icon = { CRITICAL: "🔴", WARN: "🟡", OK: "🟢" };
const lines = findings.map((f) => {
  let s = `${icon[f.level]} ${f.check.padEnd(11)} ${f.message}`;
  if (f.detail?.length) s += `\n${f.detail.slice(0, 25).map((d) => `      • ${d}`).join("\n")}` +
    (f.detail.length > 25 ? `\n      …+${f.detail.length - 25} more` : "");
  return s;
});

say("");
say("═══════════════════════════════════════════════════════════");
say(`  Quicklly catalog health — ${snapshot.ranAt}`);
say(`  ${snapshot.total.toLocaleString()} products across ${snapshot.stores.length} stores`);
say("═══════════════════════════════════════════════════════════");
say(lines.join("\n"));
say("");
say(critical.length ? `FAILED — ${critical.length} critical, ${warn.length} warning` : `PASSED${warn.length ? ` — ${warn.length} warning` : ""}`);
say("");

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
fs.writeFileSync(
  path.join(LOG_DIR, `quicklly-health-${snapshot.ranAt.slice(0, 10)}.json`),
  JSON.stringify({ snapshot, findings }, null, 2)
);
if (JSON_ONLY) console.log(JSON.stringify({ snapshot, findings }, null, 2));

// ── alert ────────────────────────────────────────────────────────────────────
// Email on: any critical; a WARNING that was not there the previous run (a persistent one,
// e.g. UNSERVED cities, would otherwise mail every day); and the first PASS after a failure.
// The previous run's verdict comes from the snapshot the last run wrote.
const prevVerdict = (() => { try { return JSON.parse(fs.readFileSync(SNAPSHOT_PREV, "utf8")); } catch { return null; } })();
const nonOk = findings.filter((f) => f.level !== "OK");
const newWarnings = warn.filter((f) => !(prevVerdict?.warnings || []).includes(f.check));
const wasFailing = !!prevVerdict?.critical?.length;
const summary = `${snapshot.total.toLocaleString()} products / ${snapshot.stores.length} stores`;
const detailText = nonOk.map((f) => `${f.level} ${f.check}: ${f.message}` + (f.detail?.length ? `\n    ${f.detail.slice(0, 15).join("\n    ")}` : "")).join("\n\n");
if (critical.length) {
  const title = `Quicklly catalog health FAILED — ${critical.length} critical`;
  await alert(title, `${title}\n${summary}\n\n${detailText}\n\nLog: ${LOG_DIR}`);
} else if (newWarnings.length) {
  const title = `Quicklly catalog health: new warning — ${newWarnings.map((f) => f.check).join(", ")}`;
  await alert(title, `${title}\n${summary}\n\n${detailText}\n\nLog: ${LOG_DIR}`);
} else if (wasFailing) {
  const title = "Quicklly catalog health recovered — PASSED";
  await alert(title, `${title}\n${summary}${warn.length ? `\n\n${detailText}` : ""}`);
}
fs.writeFileSync(SNAPSHOT_PREV, JSON.stringify({ ranAt: snapshot.ranAt, critical: critical.map((f) => f.check), warnings: warn.map((f) => f.check) }));

async function sendgridEmail(key, from, to, title, body) {
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: to.split(",").map((s) => s.trim()).filter(Boolean).map((email) => ({ email })) }],
      from: { email: from, name: "Runa sync monitor" },
      subject: title,
      content: [{ type: "text/plain", value: body }],
    }),
  });
  if (r.status !== 202) throw new Error(`SendGrid HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function alert(title, body) {
  const hook = env.QUICKLLY_ALERT_WEBHOOK;
  if (hook) {
    try {
      await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, content: body }) });
      say("Alert sent to webhook.");
    } catch (e) { say(`Webhook alert failed: ${e.message}`); }
  }
  const to = env.QUICKLLY_ALERT_EMAIL_TO;
  const from = env.QUICKLLY_ALERT_EMAIL_FROM;
  if (to && from && env.SENDGRID_API_KEY) {
    try {
      await sendgridEmail(env.SENDGRID_API_KEY, from, to, title, body);
      say(`Alert emailed to ${to} (SendGrid).`);
    } catch (e) { say(`Email alert failed: ${e.message}`); }
  } else if (to && from) {
    try {
      const { SESClient, SendEmailCommand } = await import("@aws-sdk/client-ses");
      const ses = new SESClient({ region: env.AWS_REGION || "us-east-1" });
      await ses.send(new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: to.split(",").map((s) => s.trim()).filter(Boolean) },
        Message: { Subject: { Data: title }, Body: { Text: { Data: body } } },
      }));
      say(`Alert emailed to ${to}.`);
    } catch (e) { say(`Email alert failed: ${e.message}`); }
  }
  if (!hook && !(to && from)) {
    say("No alert channel configured (QUICKLLY_ALERT_WEBHOOK / QUICKLLY_ALERT_EMAIL_TO+FROM) — exit code only.");
  }
}

process.exit(critical.length ? 1 : 0);
