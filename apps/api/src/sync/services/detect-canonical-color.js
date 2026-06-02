import fetch from "node-fetch";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { config as runaConfig } from "@runa/config";
import { geminiWithRetry } from "../utils/index.js";

const genAI = new GoogleGenerativeAI(runaConfig.gemini.apiKey);
const DEFAULT_MODEL = runaConfig.gemini.liteModel || runaConfig.gemini.model;

// Canonical colors used by bronzesnake.com's storefront color filter
// (source: filter.p.m.customAttributes.colour facet values).
export const BRONZE_SNAKE_CANONICAL_COLORS = [
  "Beige", "Black", "Blue", "Bone", "Brown", "Carmine", "Charcoal", "Choc",
  "Chocolate", "Clear", "Cream", "Dark Grey", "Gold", "Green", "Grey",
  "Heather Grey", "Ivory", "Khaki", "Light Blue", "Navy", "Nude", "Oat",
  "Orange", "Pink", "Purple", "Red", "Sand", "Silver", "Tan", "Tort",
  "White", "White Gold", "Yellow",
];

const CANONICAL_BY_LOWER = new Map(
  BRONZE_SNAKE_CANONICAL_COLORS.map(c => [c.toLowerCase(), c])
);

// Bucket-merge map: collapses near-duplicate / sub-shade buckets into the
// dominant parent color so the storefront filter has a cleaner ~19-color
// palette instead of the noisy 33-color Shopify source. Anything not in
// this map passes through unchanged.
const CANONICAL_COLOR_BUCKETS = {
  "Choc": "Brown",
  "Chocolate": "Brown",
  "Tan": "Brown",
  "Charcoal": "Grey",
  "Dark Grey": "Grey",
  "Heather Grey": "Grey",
  "Ivory": "Cream",
  "Bone": "Cream",
  "Light Blue": "Blue",
  "Navy": "Blue",
  "Carmine": "Red",
  "Oat": "Beige",
  "Sand": "Beige",
  "Nude": "Beige",
  "Khaki": "Green",
};

// The de-duplicated display set actually stored on Product nodes, derived
// from BRONZE_SNAKE_CANONICAL_COLORS minus everything merged away above.
export const BRONZE_SNAKE_DISPLAY_COLORS = BRONZE_SNAKE_CANONICAL_COLORS
  .filter(c => !(c in CANONICAL_COLOR_BUCKETS));

// Normalize any color string to the canonical display bucket:
//   1. case/whitespace fix (matches against the 33-color source list)
//   2. bucket-merge sub-shades into their parent color
// Returns null for empty input; passes through unknown values trimmed.
export function normalizeCanonicalColor(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const recased = CANONICAL_BY_LOWER.get(trimmed.toLowerCase()) || trimmed;
  return CANONICAL_COLOR_BUCKETS[recased] || recased;
}

/**
 * Ask Gemini to bucket a product into ONE of the provided canonical colors,
 * using the product's main image + title as evidence.
 *
 * @param {Object} args
 * @param {string} args.title         Product title (helps disambiguate when
 *                                    the image is ambiguous, e.g. metallic vs
 *                                    silver vs gold).
 * @param {string} args.imageUrl      Main product image URL.
 * @param {string[]} [args.allowedColors=BRONZE_SNAKE_CANONICAL_COLORS]
 * @param {string} [args.model]
 * @returns {Promise<{ color: string|null, reason?: string }>}
 */
export async function detectCanonicalColor({
  title,
  imageUrl,
  allowedColors = BRONZE_SNAKE_CANONICAL_COLORS,
  model: modelName = DEFAULT_MODEL,
}) {
  if (!imageUrl) return { color: null, reason: "no image url" };

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          color: { type: SchemaType.STRING, enum: allowedColors },
          reason: { type: SchemaType.STRING },
        },
        required: ["color"],
      },
    },
  });

  const prompt = `You are bucketing a fashion product into ONE storefront color filter.

Product title: "${title || "(no title)"}"

Look at the product image carefully. Pick the SINGLE color from the list below
that best describes the DOMINANT color of the product itself (ignore the
background, models' skin, props, shadows).

Rules:
- Output exactly one value from the allowed list — no other strings.
- If the product has multiple colors (e.g. a print), pick the most dominant
  base color a shopper would associate with the product.
- "Choc" and "Chocolate" both mean dark brown — prefer "Chocolate" unless
  the product is clearly the lighter "Choc" shade.
- "Tort" = tortoiseshell (for sunglasses / accessories).
- "Bone" / "Ivory" / "Cream" — pick the closest shade; if ambiguous prefer "Cream".

Allowed colors (pick ONE): ${allowedColors.join(", ")}

Also include a short "reason" (one sentence) explaining the pick.`;

  const parts = [prompt];
  try {
    const r = await fetch(imageUrl);
    if (r.ok) {
      const buf = await r.buffer();
      const mimeType = r.headers.get("content-type") || "image/jpeg";
      parts.push({ inlineData: { mimeType, data: buf.toString("base64") } });
    } else {
      return { color: null, reason: `image fetch ${r.status}` };
    }
  } catch (e) {
    return { color: null, reason: `image fetch error: ${e.message}` };
  }

  try {
    const result = await geminiWithRetry(() => model.generateContent(parts));
    const json = JSON.parse(result.response.text());
    if (!allowedColors.includes(json.color)) {
      return { color: null, reason: `gemini returned out-of-set value: ${json.color}` };
    }
    // Bucket Gemini's pick down to the merged display set (e.g. "Carmine"
    // → "Red", "Navy" → "Blue") so the value matches the metafield path.
    return { color: normalizeCanonicalColor(json.color), reason: json.reason };
  } catch (e) {
    return { color: null, reason: `gemini error: ${e.message}` };
  }
}
