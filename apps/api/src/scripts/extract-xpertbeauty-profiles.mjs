#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * XPERT BEAUTY — product → beauty-profile affinity (Layer 1/2 of the retail graph)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every product gets an affinity score (0–1) for each of the 10 beauty profiles (6 hair, 4 skin),
 * plus domain (hair|skin|neutral), universal flag, pro_only flag, line, size class.
 *
 * Scores come from three sources, in priority order:
 *   1. leaf category  (deterministic, 1.0)  e.g. "Sampon pentru par vopsit" → par_vopsit
 *   2. line dictionary (deterministic, 0.85) e.g. "Blonde Perfecting Purple" → blond_decolorat
 *   3. LLM (gpt-4o-mini, JSON schema) over title + description + categories + attributes. Its instructions are the
 *      store record's chat.profileScoringPrompt (edited + published from runa-prompt-labs prompts/profile_scoring.md);
 *      SYSTEM below is only the fallback. Preview one product in the lab: npm run scores -- --client xpertbeauty --product <id>
 *   Final = max(deterministic, llm). A deterministic 1.0 the LLM scores < 0.3 → review flag.
 *
 * Writes (idempotent, resume-safe — skips products with profileScoredAt unless --force):
 *   Product: pf_<profile> floats, domain, universal, proOnly, sizeClass, line (if missing),
 *            profileReview, profileScoredAt
 *   Ontology: (:HairType|:SkinType {key, name_ro, domain})  ← universal nodes, NOT store-scoped
 *             (p)-[:SUITABLE_FOR {score, source}]->(profile)   for score >= 0.6
 *   Review CSVs: apps/data/xpertbeauty_profiles_review/<profile>.csv (top 200 by score)
 *
 * Usage (from apps/api):
 *   node src/scripts/extract-xpertbeauty-profiles.mjs --dry-run --max 20     # see the LLM output
 *   node src/scripts/extract-xpertbeauty-profiles.mjs                        # all unscored products
 *   node src/scripts/extract-xpertbeauty-profiles.mjs --force                # re-score everything
 *   node src/scripts/extract-xpertbeauty-profiles.mjs --review-csv           # only (re)write the CSVs
 * Cost: ~11k products × 1 gpt-4o-mini call ≈ $6–12 once; then only new products.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import dotenv from "dotenv"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
import fetch from "node-fetch";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");

const STORE = "xpertbeauty.ro";
const MODEL = process.env.PROFILE_MODEL || "gpt-4o-mini";
const CONCURRENCY = parseInt(process.env.PROFILE_CONCURRENCY || "8", 10);
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run"), FORCE = args.includes("--force"), CSV_ONLY = args.includes("--review-csv");
const MAX = args.includes("--max") ? parseInt(args[args.indexOf("--max") + 1], 10) : 0;
const REVIEW_DIR = path.resolve(__dirname, "../../../../data/xpertbeauty_profiles_review");

// ── the 10 profiles (ontology) ─────────────────────────────────────────────────
export const PROFILES = [
  { key: "par_vopsit",                domain: "hair", name_ro: "păr vopsit" },
  { key: "blond_decolorat",           domain: "hair", name_ro: "blond decolorat" },
  { key: "par_uscat_deteriorat",      domain: "hair", name_ro: "păr uscat / deteriorat" },
  { key: "par_fin_fara_volum",        domain: "hair", name_ro: "păr fin, fără volum" },
  { key: "par_ondulat_cret",          domain: "hair", name_ro: "păr ondulat / creț" },
  { key: "scalp_gras_sensibil_matreata", domain: "hair", name_ro: "scalp gras, sensibil sau cu mătreață" },
  { key: "ten_uscat_deshidratat",     domain: "skin", name_ro: "ten uscat / deshidratat" },
  { key: "ten_gras_mixt_imperfectiuni", domain: "skin", name_ro: "ten gras / mixt, cu imperfecțiuni" },
  { key: "ten_sensibil_reactiv",      domain: "skin", name_ro: "ten sensibil / reactiv" },
  { key: "ten_matur",                 domain: "skin", name_ro: "ten matur" },
];
const KEYS = PROFILES.map(p => p.key);

// ── 1) leaf category → profile (deterministic 1.0). Category names as stored (diacritics-free).
const CATEGORY_RULES = [
  [/par vopsit|par blond/i,                     "par_vopsit"],   // blond shampoos also protect colour
  [/par blond/i,                                "blond_decolorat"],
  [/par deteriorat|par uscat|par fragil/i,      "par_uscat_deteriorat"],
  [/volum|par fragil/i,                         "par_fin_fara_volum"],
  [/cret-ondulat|cret|ondulat/i,                "par_ondulat_cret"],
  [/scalp|matreata|par gras/i,                  "scalp_gras_sensibil_matreata"],
  [/ten uscat|hidrat/i,                         "ten_uscat_deshidratat"],
  [/ten gras|matifiant|imperfectiuni/i,         "ten_gras_mixt_imperfectiuni"],
  [/ten sensibil|calmant/i,                     "ten_sensibil_reactiv"],
  [/antirid|anti-rid|anti-imbatranire|matur|gat si decolteu/i, "ten_matur"],
];
// ── 2) line / title dictionary → profile (deterministic 0.85)
const LINE_RULES = [
  [/blonde|blond|purple|violet|silver|no yellow|anti.?yellow|platinum|lumi(e|è)re|sheer blonde|blondifier/i, "blond_decolorat"],
  [/color|colour|chroma|vopsit|colorat|kolor|colorlast|color ?care|color ?brilliance|color ?motion/i, "par_vopsit"],
  [/repair|damage|bond|plex|rebuild|resistance|therapiste|reconstruct|restore|nutri|nourish|moisture|hydra|hidrat/i, "par_uscat_deteriorat"],
  [/volume|volum|plumping|bodifying|thick|densif|fine hair|par fin|full/i, "par_fin_fara_volum"],
  [/curl|curly|cret|bucle|ondulat|wave|nutricurls|killer curls/i, "par_ondulat_cret"],
  [/scalp|matreata|dandruff|anti.?dandruff|sebo|oily scalp|purifying|balance|specifique|sensitive scalp|calm(ing)? scalp/i, "scalp_gras_sensibil_matreata"],
  [/hydra|hidrat|moistur|aqua|deshidrat|dry skin|ten uscat/i,   "ten_uscat_deshidratat"],
  [/matif|mattif|oil.?control|purif|imperfec|acne|sebum|pore|ten gras|blemish|clarif/i, "ten_gras_mixt_imperfectiuni"],
  [/sensib|sensitive|calm|sooth|reactiv|redness|rosacea|cuperoz|atopic|hipoalerg/i, "ten_sensibil_reactiv"],
  [/anti.?age|anti.?aging|antirid|anti.?rid|wrinkle|lift|firm|matur|collagen|colagen|retinol|hyaluron/i, "ten_matur"],
];
const PRO_ONLY = /vopsea|oxidant|decolorant|blondor|pudra decoloranta|crema decoloranta|lightener|developer/i;
const domainOf = (cat, cats) => {
  const all = [cat, ...(cats || [])].join(" | ").toLowerCase();
  if (/\bpar\b|sampon|balsam|masc[ai] (de |pentru )?par|styling|fixativ|vopsea|oxidant|coafare/.test(all)) return "hair";
  if (/\bten\b|fata|antirid|demachiant|ser |crema de fata|fond de ten|corector/.test(all)) return "skin";
  return "neutral";
};
const sizeClass = (v, u) => (v == null ? null : u === "ml" || u === "g" ? (v <= 75 ? "travel" : v >= 750 ? "salon" : "standard") : null);

const PROFILE_DOMAIN = Object.fromEntries(PROFILES.map(p => [p.key, p.domain]));
// Deterministic scores are DOMAIN-GATED: a hair product can only pick up hair profiles (so
// "Moisture Repair" on a conditioner never lights up ten_uscat), a skin product only skin ones,
// and neutral products (nails, tools, body…) get none — the LLM decides for those.
function deterministic(p, dom) {
  const det = {}; const src = {};
  if (dom === "neutral") return { det, src };
  const cats = [p.category, ...(p.magentoCategories || [])].filter(Boolean);
  for (const c of cats) for (const [re, key] of CATEGORY_RULES) if (PROFILE_DOMAIN[key] === dom && re.test(c)) { det[key] = 1.0; src[key] = "category"; }
  const text = `${p.title || ""} ${p.line || ""}`;
  for (const [re, key] of LINE_RULES) if (PROFILE_DOMAIN[key] === dom && re.test(text) && !(det[key] >= 1)) { det[key] = Math.max(det[key] || 0, 0.85); src[key] = src[key] || "line"; }
  return { det, src };
}

// ── 3) LLM ─────────────────────────────────────────────────────────────────────
const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    domain: { type: "string", enum: ["hair", "skin", "neutral"] },
    universal: { type: "boolean" },
    pro_only: { type: "boolean" },
    line: { type: ["string", "null"] },
    profiles: { type: "object", additionalProperties: false, required: KEYS,
      properties: Object.fromEntries(KEYS.map(k => [k, { type: "number" }])) },
  },
  required: ["domain", "universal", "pro_only", "line", "profiles"],
};
const SYSTEM = `You classify beauty products (Romanian retailer) against 10 customer profiles. For each profile give an affinity score on this ANCHORED scale — use the anchors, do not default to the middle:
  0.0 = irrelevant or counter-productive for that profile
  0.2 = neutral: works for anyone, nothing targeted (this is the DEFAULT for most profiles)
  0.6 = suitable: a real, stated benefit for that profile
  0.85 = designed for it (the line or claims target it)
  1.0 = specifically and explicitly for it
A typical product has 1–3 profiles at ≥ 0.6 and the rest at ≤ 0.3. Never give every profile the same score. Rules:
- HAIR profiles: par_vopsit (colour-treated), blond_decolorat (bleached/blonde: toning, anti-yellow, bond repair), par_uscat_deteriorat (dry/damaged: repair, nourish), par_fin_fara_volum (fine, flat: volume, lightweight), par_ondulat_cret (wavy/curly: definition, anti-frizz), scalp_gras_sensibil_matreata (oily/sensitive scalp, dandruff).
- SKIN profiles: ten_uscat_deshidratat (dry/dehydrated), ten_gras_mixt_imperfectiuni (oily/combination, blemishes), ten_sensibil_reactiv (sensitive/reactive), ten_matur (mature: anti-age, firmness).
- Make-up: foundation/concealer/powder may score skin profiles by finish (matte→oily, hydrating/dewy→dry); other make-up, nails, body, tools, devices → all near 0 and universal=true.
- universal=true when the product suits everyone in its domain (e.g. "toate tipurile de par", a plain hairspray, a hairbrush) — then keep all profile scores ≤ 0.3 unless one is clearly targeted.
- pro_only=true for professional hair colour, developers, bleach, salon-only technical products.
- line = the brand sub-line if evident from the title (e.g. "Blonde Perfecting Purple", "Invigo Scalp Balance"), else null.
- Bleached blonde implies damaged: blond products usually also score par_uscat_deteriorat ≥ 0.5.
Be decisive; use the description's stated purpose, not marketing fluff.`;

// The live instructions: the store record (getUser API, no credentials needed); SYSTEM when it has none.
let SCORING_PROMPT = SYSTEM, SCORING_SOURCE = "bundled fallback";
try {
  const r = await fetch(`https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app?action=getUser&shop=${STORE}`);
  const rec = (await r.json())?.data;
  if (rec?.chat?.profileScoringPrompt) { SCORING_PROMPT = rec.chat.profileScoringPrompt; SCORING_SOURCE = "published (store record)"; }
} catch (e) { console.log(`profileScoringPrompt not read (${e.message}) — using the bundled prompt`); }
console.log(`scoring prompt: ${SCORING_SOURCE} (${SCORING_PROMPT.length} chars)`);

async function llmScore(p) {
  const user = `Title: ${p.title}\nCategory: ${p.category || ""}\nAll categories: ${(p.magentoCategories || []).join(" | ")}\nLine: ${p.line || ""}\nAttributes: ${["attr_tip_par","attr_tip_ten","attr_tip_piele","attr_tip_scalp","attr_pentru","attr_beneficii","attr_destinat_pentru"].map(a => p[a] ? `${a.slice(5)}=${[].concat(p[a]).join(",")}` : "").filter(Boolean).join("; ")}\nDescription: ${(p.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500)}`;
  const body = { model: MODEL, temperature: 0, messages: [{ role: "system", content: SCORING_PROMPT }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "beauty_profile_affinity", strict: true, schema: SCHEMA } } };
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body), timeout: 60000 });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      return JSON.parse(j.choices[0].message.content);
    } catch (e) { if (i === 3) throw e; await new Promise(res => setTimeout(res, 1500 * i)); }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
const svc = new Neo4jService(); const driver = svc.getDriver();
async function ensureOntology(session) {
  await session.run(`UNWIND $ps AS pr
    FOREACH (_ IN CASE WHEN pr.domain='hair' THEN [1] ELSE [] END | MERGE (h:HairType {key: pr.key}) SET h.name_ro = pr.name_ro, h.domain = 'hair')
    FOREACH (_ IN CASE WHEN pr.domain='skin' THEN [1] ELSE [] END | MERGE (s:SkinType {key: pr.key}) SET s.name_ro = pr.name_ro, s.domain = 'skin')`, { ps: PROFILES });
}
async function writeReviewCsv(session) {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  for (const pr of PROFILES) {
    const res = await session.run(`MATCH (p:Product {storeId:$s}) WHERE p['pf_'+$k] >= 0.6
      RETURN p.id AS id, p.title AS title, p.category AS category, p['pf_'+$k] AS score, p.profileReview AS review, p.inStock AS inStock
      ORDER BY score DESC, p.title LIMIT 200`, { s: STORE, k: pr.key });
    const rows = res.records.map(r => [r.get("id"), r.get("title"), r.get("category"), Number(r.get("score")).toFixed(2), r.get("review") ? "REVIEW" : "", r.get("inStock") ? "in stock" : "oos", ""]);
    const csv = ["sku,title,category,score,flag,stock,ok? (y/n)", ...rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    fs.writeFileSync(path.join(REVIEW_DIR, `${pr.key}.csv`), csv);
    console.log(`  review csv: ${pr.key}.csv (${rows.length} rows)`);
  }
}
const stats = { scored: 0, review: 0, errors: 0, byDomain: { hair: 0, skin: 0, neutral: 0 } };
try {
  const session = driver.session();
  if (!DRY) await ensureOntology(session);
  if (!CSV_ONLY) {
    const where = FORCE ? "" : "AND p.profileScoredAt IS NULL";
    const res = await session.run(`MATCH (p:Product {storeId:$s}) WHERE true ${where}
      RETURN p.id AS id, p.title AS title, p.description AS description, p.category AS category, p.magentoCategories AS magentoCategories,
             p.line AS line, p.sizeValue AS sizeValue, p.sizeUnit AS sizeUnit,
             p.attr_tip_par AS attr_tip_par, p.attr_tip_ten AS attr_tip_ten, p.attr_tip_piele AS attr_tip_piele, p.attr_tip_scalp AS attr_tip_scalp,
             p.attr_pentru AS attr_pentru, p.attr_beneficii AS attr_beneficii, p.attr_destinat_pentru AS attr_destinat_pentru
      ${MAX ? "LIMIT " + MAX : ""}`, { s: STORE });
    const products = res.records.map(r => Object.fromEntries(r.keys.map(k => [k, r.get(k)])));
    console.log(`${products.length} products to score (model ${MODEL}, concurrency ${CONCURRENCY}${DRY ? ", DRY-RUN" : ""})`);
    let idx = 0;
    const worker = async () => {
      while (idx < products.length) {
        const p = products[idx++];
        try {
          const domDet = domainOf(p.category, p.magentoCategories);
          const { det, src } = deterministic(p, domDet);
          const llm = await llmScore(p);
          const final = {}; const source = {}; let review = false;
          for (const k of KEYS) {
            const d = det[k] || 0, l = Math.max(0, Math.min(1, Number(llm.profiles[k] || 0)));
            final[k] = Math.max(d, l); source[k] = d >= l ? (src[k] || "llm") : "llm";
            if (d >= 1 && l < 0.3) review = true;
          }
          const domain = domDet !== "neutral" ? domDet : (llm.domain || "neutral");
          const proOnly = llm.pro_only || PRO_ONLY.test(p.title || "");
          const props = { domain, universal: !!llm.universal, proOnly, profileReview: review, sizeClass: sizeClass(p.sizeValue, p.sizeUnit) };
          for (const k of KEYS) props["pf_" + k] = Math.round(final[k] * 100) / 100;
          if (!p.line && llm.line) props.line = llm.line;
          stats.scored++; stats.byDomain[domain] = (stats.byDomain[domain] || 0) + 1; if (review) stats.review++;
          if (DRY) { console.log(`\n${p.title}\n  domain=${domain} universal=${props.universal} proOnly=${proOnly} review=${review}\n  ` + KEYS.filter(k => final[k] >= 0.3).map(k => `${k}=${final[k].toFixed(2)}(${source[k]})`).join("  ")); continue; }
          const edges = KEYS.filter(k => final[k] >= 0.6).map(k => ({ key: k, score: props["pf_" + k], source: source[k], domain: PROFILES.find(x => x.key === k).domain }));
          // Edge writes contend on the 10 shared profile nodes (SUITABLE_FOR); retry transient deadlocks.
          const s2 = driver.session();
          try {
            for (let attempt = 1; ; attempt++) {
              try {
            await s2.run(`MATCH (p:Product {id:$id, storeId:$s}) SET p += $props, p.profileScoredAt = datetime()
              WITH p OPTIONAL MATCH (p)-[old:SUITABLE_FOR]->() DELETE old
              WITH DISTINCT p UNWIND $edges AS e
              OPTIONAL MATCH (h:HairType {key:e.key}) OPTIONAL MATCH (sk:SkinType {key:e.key})
              FOREACH (n IN [x IN [h, sk] WHERE x IS NOT NULL] | MERGE (p)-[r:SUITABLE_FOR]->(n) SET r.score = e.score, r.source = e.source)`,
              { id: p.id, s: STORE, props, edges });
                break;
              } catch (e) {
                const dead = /DeadlockDetected|can't acquire|ForsetiClient/i.test(e.message || "");
                if (!dead || attempt >= 5) throw e;
                await new Promise(r => setTimeout(r, 200 * attempt + Math.random() * 300));
              }
            }
          } finally { await s2.close(); }
          if (stats.scored % 200 === 0) console.log(`  ${stats.scored}/${products.length} scored (review ${stats.review}, errors ${stats.errors})`);
        } catch (e) { stats.errors++; console.warn(`  ✗ ${p.id}: ${e.message}`); }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log("\ndone:", JSON.stringify(stats));
  }
  if (!DRY) await writeReviewCsv(session);
  await session.close();
} finally { await driver.close(); }
