#!/usr/bin/env node

/**
 * Compare three IP geolocation providers on the same set of real IPs:
 *   - freeipapi.com   (the candidate)
 *   - iplocate.io     (current)
 *   - ip-api.com      (previous)
 *
 * Pulls the most recent N unique IPs from CacheTable demo_visits_* records
 * and queries all three. Prints a side-by-side report and a summary.
 *
 * Usage:
 *   node apps/api/src/scripts/compare-geo-providers.js [--limit 30]
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
const DEMO_STORE_ID = "demo_searches";
const IPLOCATE_API_KEY = process.env.IPLOCATE_API_KEY || "a356a1ece830de39681b8b20f87b07ec";
const FREEIPAPI_KEY = process.env.FREEIPAPI_KEY || "327c070baca43e6eff672540aa44fb579297c96ffd505b4fbe45c3099be6fc74";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadVisits() {
  const items = [];
  let ExclusiveStartKey;
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
  } while (ExclusiveStartKey);
  return items;
}

async function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

async function lookupFreeIpApi(ip) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fetch(`https://free.freeipapi.com/api/json/${ip}`, {
      headers: { Authorization: `Bearer ${FREEIPAPI_KEY}` },
    }), 8000);
    const dt = Date.now() - t0;
    if (!r.ok) return { error: `HTTP ${r.status}`, dt };
    const d = await r.json();
    return {
      country: d.countryName || null,
      countryCode: d.countryCode || null,
      city: d.cityName || null,
      region: d.regionName || null,
      org: d.asnOrganization || d.asn || null,
      proxy: !!d.isProxy,
      dt,
    };
  } catch (e) {
    return { error: e.message, dt: Date.now() - t0 };
  }
}

async function lookupIplocate(ip) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fetch(`https://iplocate.io/api/lookup/${ip}?apikey=${IPLOCATE_API_KEY}`), 8000);
    const dt = Date.now() - t0;
    if (!r.ok) return { error: `HTTP ${r.status}`, dt };
    const d = await r.json();
    return {
      country: d.country || null,
      countryCode: d.country_code || null,
      city: d.city || null,
      org: d.company?.name || d.asn?.name || null,
      hosting: !!d.privacy?.is_hosting,
      vpn: !!d.privacy?.is_vpn,
      proxy: !!d.privacy?.is_proxy,
      tor: !!d.privacy?.is_tor,
      dt,
    };
  } catch (e) {
    return { error: e.message, dt: Date.now() - t0 };
  }
}

async function lookupIpApi(ip) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,org,proxy,hosting`), 8000);
    const dt = Date.now() - t0;
    if (!r.ok) return { error: `HTTP ${r.status}`, dt };
    const d = await r.json();
    if (d.status === "fail") return { error: "fail", dt };
    return {
      country: d.country || null,
      countryCode: d.countryCode || null,
      city: d.city || null,
      org: d.org || null,
      hosting: !!d.hosting,
      proxy: !!d.proxy,
      dt,
    };
  } catch (e) {
    return { error: e.message, dt: Date.now() - t0 };
  }
}

function fmt(loc) {
  if (!loc) return "—";
  if (loc.error) return `(err: ${loc.error})`;
  const tags = [];
  if (loc.hosting) tags.push("host");
  if (loc.vpn) tags.push("vpn");
  if (loc.proxy) tags.push("proxy");
  if (loc.tor) tags.push("tor");
  return `${loc.city || "?"}, ${loc.country || "?"}${tags.length ? ` [${tags.join(",")}]` : ""}`;
}

(async () => {
  console.log(`Loading demo visits …`);
  const recs = await loadVisits();
  const flat = [];
  for (const rec of recs) for (const v of rec.visits || []) flat.push({ domain: rec.domain, v });
  flat.sort((a, b) => (b.v.time || 0) - (a.v.time || 0));

  const seen = new Set();
  const sample = [];
  for (const item of flat) {
    const ip = item.v.ip?.replace(/^::ffff:/, "");
    if (!ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1") continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    sample.push({ ...item, ip });
    if (sample.length >= LIMIT) break;
  }

  console.log(`Comparing ${sample.length} unique IPs across 3 providers …\n`);

  const stats = {
    free: { ok: 0, err: 0, totalMs: 0, hostingFlags: 0 },
    iplocate: { ok: 0, err: 0, totalMs: 0, hostingFlags: 0 },
    ipapi: { ok: 0, err: 0, totalMs: 0, hostingFlags: 0 },
  };
  let cityAgreeFreeIplocate = 0;
  let countryAgreeFreeIplocate = 0;
  let cityAgreeFreeIpapi = 0;
  let countryAgreeFreeIpapi = 0;

  for (const { ip, domain } of sample) {
    const [free, ipl, ipa] = await Promise.all([
      lookupFreeIpApi(ip),
      lookupIplocate(ip),
      lookupIpApi(ip),
    ]);

    for (const [k, r] of [["free", free], ["iplocate", ipl], ["ipapi", ipa]]) {
      if (r.error) stats[k].err += 1; else stats[k].ok += 1;
      stats[k].totalMs += r.dt || 0;
      if (r.hosting) stats[k].hostingFlags += 1;
    }

    if (!free.error && !ipl.error) {
      if ((free.country || "") === (ipl.country || "")) countryAgreeFreeIplocate += 1;
      if ((free.city || "") === (ipl.city || "")) cityAgreeFreeIplocate += 1;
    }
    if (!free.error && !ipa.error) {
      if ((free.country || "") === (ipa.country || "")) countryAgreeFreeIpapi += 1;
      if ((free.city || "") === (ipa.city || "")) cityAgreeFreeIpapi += 1;
    }

    console.log(`IP ${ip.padEnd(18)} ${domain?.padEnd(28) || ""}`);
    console.log(`  freeipapi : ${fmt(free).padEnd(50)}  ${free.dt}ms  ${free.org || ""}`);
    console.log(`  iplocate  : ${fmt(ipl).padEnd(50)}  ${ipl.dt}ms  ${ipl.org || ""}`);
    console.log(`  ip-api    : ${fmt(ipa).padEnd(50)}  ${ipa.dt}ms  ${ipa.org || ""}`);
    console.log();

    await sleep(150);
  }

  const N = sample.length;
  const fcomp = (k) => {
    const s = stats[k];
    return `ok=${s.ok}/${N}  err=${s.err}  avg=${Math.round(s.totalMs / Math.max(1, N))}ms  hosting=${s.hostingFlags}`;
  };

  console.log(`— Summary (${N} IPs) —`);
  console.log(`freeipapi.com : ${fcomp("free")}`);
  console.log(`iplocate.io   : ${fcomp("iplocate")}`);
  console.log(`ip-api.com    : ${fcomp("ipapi")}`);
  console.log(`\nAgreement with iplocate.io  →  country: ${countryAgreeFreeIplocate}/${N}   city: ${cityAgreeFreeIplocate}/${N}`);
  console.log(`Agreement with ip-api.com   →  country: ${countryAgreeFreeIpapi}/${N}   city: ${cityAgreeFreeIpapi}/${N}`);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
