#!/usr/bin/env node

/**
 * Verify accuracy of stored demo-search geo data.
 *
 * Scans CacheTable for all `demo_visits_*` items, takes each unique IP, asks
 * ipapi.is for the current country/city, and prints a side-by-side report
 * comparing what's stored vs. what ipapi.is returns.
 *
 * Usage:
 *   node apps/api/src/scripts/verify-demo-geo.js [--limit 200] [--unique]
 *
 *   --limit N    only check the most recent N visits in total (default 100)
 *   --unique     check each unique IP at most once (recommended)
 *   --fix        rewrite the stored visits with the ipapi.is values
 *                (DESTRUCTIVE — only use after eyeballing the report)
 *   --classify   backfill ALL historical visits with bot/hosting/vpn/proxy
 *                flags using ipapi.is's privacy fields. Adds: org, isHosting,
 *                isVpn, isProxy, isTor, isCrawler, isAbuser, isBot, botReason.
 *                Does NOT touch country/city. Bypasses --limit / --unique
 *                (processes everything). Does its own dedup so each unique
 *                IP is looked up once. Safe to re-run.
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

import fetch from "node-fetch";
import AWS from "aws-sdk";
import { AWS_REGION } from "../sync/services/config.js";

AWS.config.update({ region: AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const CACHE_TABLE = process.env.DYNAMODB_CACHE_TABLE || "CacheTable";
const IPAPI_IS_KEY = process.env.IPAPI_IS_KEY || "c53e943ae4ed8fe820c6";
const DEMO_STORE_ID = "demo_searches";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 100;
const UNIQUE = args.includes("--unique");
const FIX = args.includes("--fix");
const CLASSIFY = args.includes("--classify");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanDemoVisits() {
  const items = [];
  let ExclusiveStartKey;
  let pages = 0;
  do {
    const res = await ddb.query({
      TableName: CACHE_TABLE,
      IndexName: "storeId-index",
      KeyConditionExpression: "storeId = :sid",
      FilterExpression: "begins_with(id, :p)",
      ExpressionAttributeValues: { ":sid": DEMO_STORE_ID, ":p": "demo_visits_" },
      ExclusiveStartKey,
    }).promise();
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
    pages += 1;
    process.stdout.write(`  page ${pages} → +${res.Items?.length || 0} (total ${items.length})\n`);
  } while (ExclusiveStartKey);
  return items;
}

async function lookupIp(ip) {
  const cleanIp = String(ip).replace(/^::ffff:/, "");
  if (!cleanIp || cleanIp === "unknown" || cleanIp === "::1" || cleanIp === "127.0.0.1") return null;
  const url = `https://api.ipapi.is?q=${cleanIp}&key=${IPAPI_IS_KEY}`;
  try {
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const d = await r.json();
    if (!d || d.error) return { error: d?.error || "no-data" };
    const dcName = d.datacenter?.datacenter || null;
    const isPrivateRelay = dcName === "iCloud Private Relay";
    const relayCity = isPrivateRelay && d.datacenter?.city
      ? d.datacenter.city.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())
      : null;
    return {
      country: d.location?.country || null,
      country_code: d.location?.country_code || null,
      city: relayCity || d.location?.city || null,
      org: d.company?.name || d.asn?.org || null,
      type: d.company?.type || d.asn?.type || null,
      hostingService: isPrivateRelay ? "iCloud Private Relay" : null,
      hostingProvider: isPrivateRelay ? "Apple" : null,
      hosting: !!d.is_datacenter,
      vpn: !!d.is_vpn,
      proxy: !!d.is_proxy,
      tor: !!d.is_tor,
      crawler: !!d.is_crawler,
      abuser: !!d.is_abuser,
      privateRelay: isPrivateRelay,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function fmt(loc) {
  if (!loc) return "—";
  if (loc.error) return `(err: ${loc.error})`;
  const tags = [];
  if (loc.hosting) tags.push("hosting");
  if (loc.vpn) tags.push("vpn");
  if (loc.proxy) tags.push("proxy");
  if (loc.tor) tags.push("tor");
  const tagStr = tags.length ? ` [${tags.join(",")}]` : "";
  const orgStr = loc.org ? ` (${loc.org}${loc.type ? `/${loc.type}` : ""})` : "";
  return `${loc.city || "?"}, ${loc.country || "?"}${orgStr}${tagStr}`;
}

// Same regex used by the live route in apps/api/src/routes/demo.js.
const BOT_UA_RE = /bot|crawler|spider|preview|monitor|headless|lighthouse|axios|curl\/|python-requests|wget|httpclient|http-client|fetch\/|node-fetch|okhttp|java-http|go-http-client|GPTBot|ClaudeBot|PerplexityBot|Bytespider|Amazonbot|Google-Extended|CCBot|OAI-SearchBot|FacebookExternalHit|Twitterbot|Slackbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot|Pingdom|UptimeRobot|StatusCake|NewRelic|Datadog/i;

function classifyBot(geo, userAgent, acceptLanguage) {
  const ua = (userAgent || "").trim();
  const al = (acceptLanguage || "").trim();
  if (geo?.privateRelay) {
    if (ua && ua.match(BOT_UA_RE)) return { isBot: true, botReason: `ua:${ua.match(BOT_UA_RE)[0]}` };
    return { isBot: false, botReason: null };
  }
  if (geo?.crawler) return { isBot: true, botReason: `crawler:${geo.org || "known"}` };
  if (geo?.proxy) return { isBot: true, botReason: "proxy" };
  if (geo?.tor) return { isBot: true, botReason: "tor" };
  if (geo?.hosting) {
    const label = geo.hostingService
      ? `${geo.hostingProvider || geo.org || "datacenter"} ${geo.hostingService}`
      : (geo.org || "datacenter");
    return { isBot: true, botReason: `hosting:${label}` };
  }
  if (ua) {
    if (ua.length < 20) return { isBot: true, botReason: "short-user-agent" };
    const m = ua.match(BOT_UA_RE);
    if (m) return { isBot: true, botReason: `ua:${m[0]}` };
    if (!al) return { isBot: true, botReason: "no-accept-language" };
  }
  return { isBot: false, botReason: null };
}

async function runClassifyBackfill(records) {
  // Collect unique IPs across all records for batch lookup.
  const allIps = new Set();
  for (const rec of records) {
    for (const v of rec.visits || []) {
      const ip = String(v.ip || "").replace(/^::ffff:/, "");
      if (ip && ip !== "unknown" && ip !== "::1" && ip !== "127.0.0.1") allIps.add(ip);
    }
  }
  console.log(`Looking up ${allIps.size} unique IPs against ipapi.is …`);

  const ipMap = new Map();
  let i = 0;
  for (const ip of allIps) {
    i += 1;
    const live = await lookupIp(ip);
    ipMap.set(ip, live || { error: "no-data" });
    if (i % 20 === 0) console.log(`  ${i}/${allIps.size}`);
    await sleep(80);
  }

  let touched = 0;
  let totalVisits = 0;
  let botsFound = 0;
  for (const rec of records) {
    const newVisits = (rec.visits || []).map((v) => {
      totalVisits += 1;
      const ip = String(v.ip || "").replace(/^::ffff:/, "");
      const live = ipMap.get(ip);
      const geo = live && !live.error ? live : null;
      const cls = classifyBot(geo, v.userAgent, v.acceptLanguage);
      if (cls.isBot) botsFound += 1;
      return {
        ...v,
        ...(geo && {
          // Promote iCloud Private Relay's real city up over the relay-exit city.
          country: geo.country || v.country || null,
          countryCode: geo.country_code || v.countryCode || null,
          city: geo.city || v.city || null,
          org: geo.org || v.org || null,
          hostingService: geo.hostingService || null,
          isHosting: !!geo.hosting,
          isVpn: !!geo.vpn,
          isProxy: !!geo.proxy,
          isTor: !!geo.tor,
          isCrawler: !!geo.crawler,
          isAbuser: !!geo.abuser,
          isPrivateRelay: !!geo.privateRelay,
        }),
        isBot: cls.isBot,
        botReason: cls.botReason,
      };
    });
    await ddb.update({
      TableName: CACHE_TABLE,
      Key: { id: rec.id },
      UpdateExpression: "SET visits = :v",
      ExpressionAttributeValues: { ":v": newVisits },
    }).promise();
    touched += 1;
    if (touched % 20 === 0) console.log(`  written ${touched}/${records.length} domain records`);
  }
  console.log(`\nDone. Updated ${touched} domain records, ${totalVisits} visits total, ${botsFound} flagged as bot (${Math.round(100 * botsFound / Math.max(1, totalVisits))}%).`);
}

(async () => {
  console.log(`Scanning ${CACHE_TABLE} for demo_visits_* …`);
  const records = await scanDemoVisits();
  console.log(`Found ${records.length} domain records.`);

  if (CLASSIFY) {
    await runClassifyBackfill(records);
    process.exit(0);
  }

  // Flatten to (domain, visit) tuples, newest first
  const flat = [];
  for (const rec of records) {
    for (const v of rec.visits || []) {
      flat.push({ domain: rec.domain || rec.id?.replace(/^demo_visits_/, ""), v });
    }
  }
  flat.sort((a, b) => (b.v.time || 0) - (a.v.time || 0));

  // Pick which visits to check
  const seenIps = new Set();
  const toCheck = [];
  for (const item of flat) {
    const ip = item.v.ip;
    if (!ip || ip === "unknown") continue;
    if (UNIQUE) {
      if (seenIps.has(ip)) continue;
      seenIps.add(ip);
    }
    toCheck.push(item);
    if (toCheck.length >= LIMIT) break;
  }

  console.log(`Checking ${toCheck.length} visits against ipapi.is …\n`);

  const ipCache = new Map();
  let mismatchCountry = 0;
  let mismatchCity = 0;
  let hostingHits = 0;
  let errors = 0;

  // store per-domain visit updates if --fix
  const updatesByDomain = new Map();

  for (let i = 0; i < toCheck.length; i++) {
    const { domain, v } = toCheck[i];
    let live = ipCache.get(v.ip);
    if (!live) {
      live = await lookupIp(v.ip);
      ipCache.set(v.ip, live);
      await sleep(120); // be nice to the API
    }

    const stored = `${v.city || "?"}, ${v.country || "?"}`;
    const liveStr = fmt(live);

    let badge = "  ";
    if (!live || live.error) {
      errors += 1;
      badge = "??";
    } else {
      if (live.hosting) hostingHits += 1;
      const cMis = (live.country || "") !== (v.country || "");
      const ciMis = (live.city || "") !== (v.city || "");
      if (cMis) mismatchCountry += 1;
      if (ciMis) mismatchCity += 1;
      if (cMis) badge = "!!";
      else if (ciMis) badge = "~~";
      else badge = "OK";
    }

    const when = new Date(v.time || 0).toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `${badge}  ${when}  ${v.ip.padEnd(40)}  ${domain.padEnd(35)}  stored: ${stored.padEnd(40)}  live: ${liveStr}`,
    );

    if (FIX && live && !live.error) {
      if (!updatesByDomain.has(domain)) updatesByDomain.set(domain, []);
      updatesByDomain.get(domain).push({ time: v.time, country: live.country, city: live.city });
    }
  }

  console.log(`\n— Summary —`);
  console.log(`Visits checked:            ${toCheck.length}`);
  console.log(`Unique IPs:                ${ipCache.size}`);
  console.log(`Country mismatches:        ${mismatchCountry}`);
  console.log(`City mismatches:           ${mismatchCity}`);
  console.log(`Hosting/datacenter IPs:    ${hostingHits}`);
  console.log(`Lookup errors:             ${errors}`);

  if (FIX) {
    console.log(`\n— Applying fixes to ${updatesByDomain.size} domains —`);
    for (const rec of records) {
      const domain = rec.domain || rec.id?.replace(/^demo_visits_/, "");
      const fixes = updatesByDomain.get(domain);
      if (!fixes?.length) continue;
      const byTime = new Map(fixes.map((f) => [f.time, f]));
      const newVisits = (rec.visits || []).map((v) => {
        const f = byTime.get(v.time);
        if (!f) return v;
        return { ...v, country: f.country || v.country, city: f.city || v.city };
      });
      await ddb.update({
        TableName: CACHE_TABLE,
        Key: { id: rec.id },
        UpdateExpression: "SET visits = :v",
        ExpressionAttributeValues: { ":v": newVisits },
      }).promise();
      console.log(`  fixed ${fixes.length} visit(s) on ${domain}`);
    }
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
