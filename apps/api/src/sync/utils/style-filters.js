// Style-filter + size-token normalization shared by the sync pipeline and the
// Bronze Snake backfill script.
//
// `custom.style_filters_new` is hand-typed by the merchant, so the same style
// appears as case/space/plural/typo variants ("Crop Tops ", "crop tops",
// "Cropped Tops"). Slugify collapses case/spacing; STYLE_FILTER_ALIASES merges
// the rest (map generated from the full live value set on 2026-06-12 via
// Gemini + manual review — regenerate only if the merchant's vocabulary drifts).

export const STYLE_FILTER_ALIASES = {
  // typos / wording variants of the same garment
  "shorts-sleeve-tops": "short-sleeve-tops",
  "cropped-tops": "crop-tops",
  "tank-tops": "tanks",
  "singlets": "tanks",
  "cropped-tanks": "crop-tanks",
  "camis": "cami-tops",
  "denim-jeans": "jeans",
  "crew-sweaters": "crew-neck-sweaters",
  "leather-style-jackets": "leather-jackets",
  "jackets-leather-jackets": "leather-jackets",
  // singular → plural
  "bracelet": "bracelets",
  "clutch": "clutches",
  "earring": "earrings",
  "set": "sets",
  "cardigan": "cardigans",
  "trouser": "trousers",
  "hair-tie": "hair-ties",
  // gender/tag-prefix leaks of a generic value
  "mens-headwear": "headwear",
  "womens-headwear": "headwear",
  "mens-accessories": "accessories",
  "womens-accessories": "accessories",
  "womens-skirt": "skirts",
  "womens-skirts": "skirts",
  "womens-shorts": "shorts",
  // not a shoppable style → drop
  "womens-bags-and-shoes": null,
  "bags-and-shoes": null,
  "genuine-leather": null,
};

export function slugifyStyleValue(v) {
  return String(v).trim().toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Raw metafield value (JSON list string) → deduped canonical slugs.
export function normalizeStyleFilters(rawValue) {
  if (!rawValue) return [];
  let arr;
  try { arr = JSON.parse(rawValue); } catch { arr = [rawValue]; }
  if (!Array.isArray(arr)) arr = [arr];
  const out = new Set();
  for (const v of arr) {
    let slug = slugifyStyleValue(v);
    if (!slug) continue;
    if (slug in STYLE_FILTER_ALIASES) slug = STYLE_FILTER_ALIASES[slug];
    if (slug) out.add(slug);
  }
  return [...out];
}

// p.sizes entries are variant titles "10 / Chocolate", "XS/S / Light Grey",
// "Default Title". The size token is the part before " / " (space-slash-space,
// so combo sizes "XS/S" survive). One-size products end up with [].
export function parseSizeTokens(sizes) {
  const out = new Set();
  for (const s of sizes || []) {
    const token = String(s).split(" / ")[0].trim().toUpperCase();
    if (!token || token === "DEFAULT TITLE") continue;
    out.add(token);
  }
  return [...out];
}

// custom.size_* metafield value → array of measurement strings. Values are
// comma-separated and positionally aligned with the size list ("50cm,50cm,52cm,55cm"
// ↔ XS,S,M,L). size_waist is sometimes a JSON list ('["30\",32\",34\""]', inches)
// — unwrap it first.
export function parseMeasureList(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (raw.startsWith("[")) {
    try { const a = JSON.parse(raw); if (Array.isArray(a)) raw = a.join(","); } catch {}
  }
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

// {bust: rawValue, waist: rawValue, ...} → compact JSON string (null when empty).
// Stored as a string because Neo4j properties can't hold nested maps.
export function buildSizeChartJson(byKey) {
  const chart = {};
  for (const [k, v] of Object.entries(byKey)) {
    const parts = parseMeasureList(v);
    if (parts) chart[k] = parts;
  }
  return Object.keys(chart).length ? JSON.stringify(chart) : null;
}

// The size-chart metafields to read (key → short dimension name used in the JSON).
export const SIZE_CHART_METAFIELDS = {
  size_bust: "bust",
  size_waist: "waist",
  size_hip: "hip",
  size_length: "length",
  size_top_length: "top_length",
  size_pant_length: "pant_length",
  size_skirt_length: "skirt_length",
  size_short_length: "short_length",
  size_sleeve_length: "sleeve_length",
  size_inseam: "inseam",
  size_pit_to_pit: "pit_to_pit",
};

// ─── Material extraction (from product descriptions) ────────────────────────
// 58% of BS descriptions carry a structured "Material: 100% Cotton" line; this
// parses those exactly. Merchant typos seen in real data are normalized.
// Blends: `dominant` = highest percentage; `materials` lists components ≥15%
// (so a 3%-linen trench does NOT match "linen").

const MATERIAL_TYPO_MAP = {
  ccotton: "cotton", coton: "cotton", payon: "rayon", polytester: "polyester",
  recycles: "recycled", pu: "vegan-leather", polyurethane: "vegan-leather",
};
const MATERIAL_TOKENS = new Set([
  "cotton","linen","polyester","viscose","wool","silk","leather","suede","denim",
  "nylon","elastane","spandex","rayon","lyocell","tencel","acrylic","cashmere",
  "jersey","satin","poplin","twill","corduroy","mesh","knit","fleece","canvas",
  "terry","modal","bamboo","cupro","ramie","lurex","polyamide","recycled","vegan-leather",
]);
// Non-percentage materials (mostly accessories), detected as phrases.
const ACCESSORY_MATERIAL_PHRASES = [
  ["genuine leather", "leather"], ["suede leather", "suede"], ["suede", "suede"],
  ["pu vegan leather", "vegan-leather"], ["vegan leather", "vegan-leather"],
  ["stainless steel", "stainless-steel"], ["sterling silver", "sterling-silver"],
  ["gold plated", "gold-plated"], ["gold-plated", "gold-plated"],
  ["acrylic frame", "acrylic"], ["canvas", "canvas"], ["straw", "straw"], ["felt", "felt"],
];

const stripHtmlForMaterial = (h) => String(h || "")
  .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// description (HTML ok) → { composition, materials, dominant } | null
export function extractMaterials(description) {
  const text = stripHtmlForMaterial(description);
  if (!text) return null;

  // 1) structured "Material:/Fabric:/Composition:" line, cut at the model-info tail
  const lineM = text.match(/(?:materials?|fabric|composition)\s*:\s*(.{2,120}?)(?=\s*(?:pictured|model|size guide|care|$))/i);
  const compSource = lineM ? lineM[1] : text;

  // 2) percentage pairs ("95% Rayon 5% Elastane", "79% Polyester, 18% Cotton, 3% Linen")
  const pairs = [...compSource.matchAll(/(\d{1,3})\s*%\s*([a-z-]+)/gi)]
    .map(m => {
      let tok = m[2].toLowerCase();
      tok = MATERIAL_TYPO_MAP[tok] || tok;
      return [Number(m[1]), tok];
    })
    .filter(([n, tok]) => n > 0 && n <= 100 && MATERIAL_TOKENS.has(tok));
  if (pairs.length) {
    pairs.sort((a, b) => b[0] - a[0]);
    const materials = [...new Set(pairs.filter(([n], i) => i === 0 || n >= 15).map(([, t]) => t))];
    return {
      composition: pairs.map(([n, t]) => `${n}% ${t}`).join(" + "),
      materials,
      dominant: materials[0],
    };
  }

  // 3) accessory phrases ("genuine leather belt", "stainless steel", "acrylic frame")
  const lower = text.toLowerCase();
  for (const [phrase, token] of ACCESSORY_MATERIAL_PHRASES) {
    if (lower.includes(phrase)) {
      return { composition: phrase, materials: [token], dominant: token };
    }
  }
  return null; // no deterministic signal — candidate for the Gemini straggler pass
}
