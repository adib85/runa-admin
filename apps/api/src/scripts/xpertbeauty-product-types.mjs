// Runa product types for Xpert Beauty — the rules and the AI calls (2026-11-16).
// Rules: apps/api/src/data/xpertbeauty-product-types.json (copy of runa-prompt-labs clients/xpertbeauty/product_types.json).
// Used by scripts/type-xpertbeauty-products.mjs (new products after each sync).
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/xpertbeauty-product-types.json"), "utf8"));

const REFILL = new RegExp(DOC.refillPrefix);
export function norm(t) {
  let s = String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = s.replace(/[^a-z0-9%+ -]/g, " ").replace(/\s+/g, " ").trim();
  return s.replace(REFILL, "");
}
const RULES = DOC.types.map((t) => ({ ...t, re: t.patterns.map((p) => (p.startsWith("~") ? new RegExp(p.slice(1)) : new RegExp("^" + p))), src: t.patterns.map((p) => (p.startsWith("~") ? p.slice(1) : p)) }));
const GENERIC = new Set(DOC.generic);
export const TYPES = []; for (const t of DOC.types) if (!TYPES.some((x) => x.id === t.id)) TYPES.push({ id: t.id, department: t.department, label: t.label });
export const DEPARTMENT = Object.fromEntries(TYPES.map((t) => [t.id, t.department]));

export function categoryType(cat) {
  if (!cat) return null;
  if (DOC.category[cat]) return DOC.category[cat];
  for (const [prefix, t] of Object.entries(DOC.categoryPrefixes)) if (cat.startsWith(prefix)) return t;
  return null;
}
export function classify(title, category) {
  const t = norm(title);
  for (const r of RULES) for (let i = 0; i < r.re.length; i++) if (r.re[i].test(t)) return { type: r.id, source: GENERIC.has(r.src[i]) ? "title-generic" : "title" };
  const ct = categoryType(category);
  if (ct) return { type: ct, source: "category" };
  return { type: "necunoscut", source: "none" };
}

// ── AI (Gemini 3.8 Flash, JSON) ──────────────────────────────────────────────────────────────────────────────────
const MODEL = process.env.XB_TYPES_MODEL || "gemini-3.8-flash";
export const usage = { in: 0, out: 0, think: 0, calls: 0 };
const TYPE_LIST = TYPES.map((t) => `${t.id} — ${t.department} — ${t.label}`).join("\n");
const SYSTEM_CLASSIFY = `You classify products of a Romanian beauty shop (xpertbeauty.ro) into ONE product type from a fixed list.
The product TYPE is what the product is (shampoo, hair mask, face serum, semi-permanent nail polish, hair dryer…), not who it is for or what it does.
Rules:
- Choose exactly one "type" id from the list. Use the title first, then the description, then the shop category (the shop category is often too broad or wrong).
- A set / gift box / bundle of several products → "set_cadou". A refill → the type of the product it refills.
- Hair products vs face products: decide from the title and description (a "ser" for hair → ser_par; for the face → ser_ten).
- If NO type in the list fits, use "alt" and put a short Romanian type name in "suggest".
- "sure": false when you hesitate between two types; then put the other one in "second".
Answer with JSON only: [{"id": "...", "type": "...", "sure": true, "second": null, "suggest": null}]

TYPES (id — department — label):
${TYPE_LIST}`;
const SYSTEM_TIEBREAK = `Products of a Romanian beauty shop (xpertbeauty.ro). For each product two classifiers disagree on its product TYPE.
Read the title and the description and choose the type that says best WHAT THE PRODUCT IS. Answer "a" or "b" only from the two given.
Answer with JSON only: [{"id": "...", "pick": "a" | "b"}]

TYPES (id — department — label):
${TYPE_LIST}`;

async function gemini(system, items) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY missing");
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(items) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } } };
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
      if (res.ok) {
        const j = await res.json(); const u = j.usageMetadata || {};
        usage.in += u.promptTokenCount || 0; usage.out += u.candidatesTokenCount || 0; usage.think += u.thoughtsTokenCount || 0; usage.calls++;
        const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || "").join("") || "[]";
        const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : [];
      }
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return [];
}
const VALID = new Set(TYPES.map((t) => t.id));
// items: [{id, title, shop_category, brand, description}] → Map(id → {type, sure, second, suggest})
export async function aiClassify(items) {
  const ans = await gemini(SYSTEM_CLASSIFY, items);
  return new Map(ans.filter((a) => a && a.id).map((a) => [a.id, { type: VALID.has(a.type) ? a.type : a.type === "alt" ? "alt" : null, sure: a.sure !== false, second: VALID.has(a.second) ? a.second : null, suggest: a.suggest || null }]));
}
// items: [{id, title, shop_category, brand, description, a, b}] → Map(id → chosen type)
export async function aiTiebreak(items) {
  const ans = await gemini(SYSTEM_TIEBREAK, items.map(({ id, title, shop_category, brand, description, a, b }) => ({ id, title, shop_category, brand, description, a, b })));
  const byId = new Map(items.map((x) => [x.id, x]));
  return new Map(ans.filter((a) => a && byId.has(a.id) && (a.pick === "a" || a.pick === "b")).map((a) => [a.id, a.pick === "a" ? byId.get(a.id).a : byId.get(a.id).b]));
}
// cost at the published price (through 2026-12-31: $0.75 in / $3.75 out per 1M tokens; doubles 2027-01-01)
export function costUSD(u = usage) { const year2027 = new Date() >= new Date("2027-01-01"); const k = year2027 ? 2 : 1; return (u.in / 1e6) * 0.75 * k + ((u.out + u.think) / 1e6) * 3.75 * k; }
