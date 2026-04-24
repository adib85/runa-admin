import fetch from "node-fetch";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { config as runaConfig } from "@runa/config";
import { geminiWithRetry } from "../utils/index.js";

const GEMINI_MODEL = runaConfig.gemini.model;
const genAI = new GoogleGenerativeAI(runaConfig.gemini.apiKey);

const groundingClients = (runaConfig.gemini.groundingApiKeys || []).map((key, i) => ({
  client: new GoogleGenerativeAI(key),
  label: `grounding-${i + 1}`
}));
let groundingRoundRobinIndex = 0;

// ─── Language-specific prompt config ─────────────────────────────────

const LANG_CONFIG = {
  ro: {
    featuresLabel: "Caracteristici",
    compositionLabel: "Compoziție produs",
    elegantSentences: "2-3 elegant sentences in Romanian — style, versatility, how to wear",
    languageRule: "The description MUST be written in ROMANIAN language",
    languageName: "ROMANIAN",
    systemLangRule: "Your final response (the product description) MUST be written in Romanian language.",
  },
  en: {
    featuresLabel: "Features",
    compositionLabel: "Material composition",
    elegantSentences: "2-3 elegant sentences in English — style, versatility, how to wear",
    languageRule: "The description MUST be written in ENGLISH language",
    languageName: "ENGLISH",
    systemLangRule: "Your final response (the product description) MUST be written in English language.",
  }
};

function getLangConfig(language) {
  return LANG_CONFIG[language] || LANG_CONFIG.ro;
}

// ─── TOFF (Romanian) description rules ────────────────────────────────

const TOFF_RULES_RO = `
TOFF DESCRIPTION RULES (mandatory — Romanian language):

LANGUAGE & TONE:
- Limbaj natural, fluent, în română corectă. EVITĂ traduceri mot-a-mot și formulări artificiale.
- Ton elegant, sofisticat, de magazin online de modă.

CUVINTE/EXPRESII INTERZISE (NU folosi NICIODATĂ):
- "premium" (în orice context)
- "fuziune" (folosește "combinație")
- "haute couture" (decât dacă e confirmat de sursă)
- "piese de croitorie relaxată" (folosește "croială lejeră")
- "vârf migdalat" (folosește "bot în formă de migdală")

REGULI PIELE:
- Pentru orice tip de piele de animal folosește DOAR cuvântul "piele".
- NU menționa: "piele de miel", "piele de vițel", "piele de oaie", "piele de cerf" etc.
- Pentru piele de crocodil, șarpe sau șopârlă folosește exclusiv "piele exotică".

ACORD GRAMATICAL:
- Verifică acordul (ex: "acești pantofi SUNT", nu "este"; "aceste sneakers", nu "acești sneakers").
- Atenție la genul produsului: pantofi/sneakers (m. pl.), sandale/cizme (f. pl.), geantă (f. sg.).

CONȚINUT:
- NU inventa informații (ex: nu atribui "haute couture" dacă nu e cazul).
- Descrierea trebuie să reflecte produsul real.

STRUCTURĂ (obligatorie în această ordine):
1. Introducere scurtă: tip produs, brand, stil (1-3 propoziții elegante)
2. Caracteristici (6-10 detalii fizice)
3. Compoziție produs
4. Opțional: o frază scurtă despre cum poate fi purtat / context

EXEMPLE BUNE (urmează EXACT acest stil, format și tonalitate):

EXEMPLU A — SANDALE:
---
Sandalele Hibiscus 105mm, Aquazzura, dau un aer refreshing ținutelor tale, fie că le porți pe timp de zi, cu o rochie vaporoasă din in sau cu o pereche de jeans, fie că le integrezi într-un look de seară, cu piese din paiete. Nuanța tonică de verde poate fi asortată cu tonuri complementare de oranj, dar și cu piese albe. <br>
<br>
Caracteristici: <br>
- sandale verzi din piele velur <br>
- model clasic strappy <br>
- bot în formă de migdală <br>
- o baretă subțire pe partea din față <br>
- șireturi pe gleznă cu elemente în formă de frunză <br>
- toc înalt subțire (10,5 cm) <br>
- interior nude din piele cu etichetă cu logo <br>
<br>
Compoziție produs: Piele 100%
---

EXEMPLU B — SANDALE STRASS:
---
Sandalele Vanessa 100mm, Sophia Webster, dau un aer statement oricărei ținute în care le porți, grație dispunerii baretelor subțiri, care pun în valoare linia gleznei, și a fluturilor aplicați, elementul semnătură al brandului. Nuanța puternică de roșu întreține senzualitatea modelului. <br>
<br>
Caracteristici: <br>
- sandale roșii din piele cu efect perlat <br>
- model strappy clasic <br>
- multiple barete subțiri pe partea din față <br>
- baretă tip șiret pe gleznă <br>
- bot în formă de migdală ascuțită <br>
- interior roșu din piele cu logo auriu <br>
- talpă subțire <br>
- toc înalt subțire (10 cm) <br>
- fluturi cu pietre aplicați pe barete <br>
<br>
Compoziție produs: Piele 100%
---

EXEMPLE GREȘITE (NU folosi astfel de formulări):
- "piele de cerf premium" → corect: "piele"
- "Finisaj spălat în nuanță Khaki Green" → corect: "finisaj spălat în nuanță verde kaki"
- "siluetă relaxată tip boxy", "mâneci raglan ample" (limbaj artificial) → folosește română fluentă: "croială lejeră, oversized"
- "acești pantofi este" (acord greșit) → "acești pantofi sunt"
`.trim();

// ─── Dimensions-only detection ────────────────────────────────────────

export function isDimensionsOnly(text) {
  if (!text) return false;
  const clean = text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (clean.length === 0 || clean.length > 100) return false;
  return /^\s*dimensiuni\b/i.test(clean);
}

const BAG_WALLET_PATTERN = /^(geant.|gen.i|borset.|rucsac|portofel|portcard|portofele)/i;

export function isBagProduct(title, productType) {
  const t = (title || "").trim();
  const p = (productType || "").trim();
  return BAG_WALLET_PATTERN.test(t) || BAG_WALLET_PATTERN.test(p);
}

// ─── Thinking-leak detector ──────────────────────────────────────────
// Detects when Gemini's chain-of-thought leaks into the visible text.
// Triggered both by suspicious openings (the model "thinking out loud")
// and by telltale meta phrases / banned-word echoes from the prompt.

const LEAK_START_PATTERNS = [
  /^thoughtful\b/i,
  /^okay[,!:\s]/i,
  /^alright[,!:\s]/i,
  /^wait[,!:\s]/i,
  /^let me\b/i,
  /^the user (wants|asks|needs|provided|gave)/i,
  /^here(?:'|')?s\b/i,
  /^based on (?:the|your)\b/i,
  /^looking at\b/i,
  /^first[,!:\s]/i,
  /^so[,!:\s]/i,
  /^hmm[,!.:\s]/i,
  /^\*\s*(intro|characteristics|composition|refining|double[\s-]check|final|correction|revised|wait|note)\b/i,
  /^\*\*\s*(intro|step|note|thought)/i,
];

const LEAK_PHRASE_PATTERNS = [
  /\*\s*wait[,\s]/i,
  /\*\s*refining\b/i,
  /\*\s*double[\s-]check\b/i,
  /\*\s*final\s+(check|version|structure|answer)/i,
  /\*\s*correction\b/i,
  /\*\s*revised\b/i,
  /let me re-?read/i,
  /looking at the (?:source|prompt|rules)/i,
  /the (?:source|prompt) (?:says|didn'?t|did not|provided)/i,
  /final check on (?:forbidden|banned)/i,
  /one (?:more|small|last) (?:check|detail|thing)/i,
  /example\s+a\b/i,
  /example\s+b\b/i,
  /\bcompozi[țt]ie produs:[\s\S]*compozi[țt]ie produs:/i, // header repeated twice
  // Banned-word echoes from the rules block (these must NEVER appear in output)
  /piese de croitorie relaxat[ăa]/i,
  /vârf migdalat/i,
  /haute couture/i,
  // Rule-block headers leaking verbatim
  /CUVINTE\s*\/\s*EXPRESII INTERZISE/i,
  /STRUCTURĂ\s*\(obligatorie/i,
  /REGULI PIELE\b/i,
  /ACORD GRAMATICAL\b/i,
  /TOFF (?:DESCRIPTION|SEO) RULES/i,
];

export function looksLikeThinkingLeak(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;

  const head = trimmed.slice(0, 120);
  for (const pat of LEAK_START_PATTERNS) {
    if (pat.test(head)) return true;
  }
  for (const pat of LEAK_PHRASE_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

// Build a generationConfig that disables thinking and pins temperature.
// Used for the "safe retry" pass after a leak is detected.
function buildNoThinkConfig({ temperature = 0.2, extra = null } = {}) {
  const cfg = {
    temperature,
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (extra && typeof extra === "object") Object.assign(cfg, extra);
  return cfg;
}

// ─── Gemini: Google Search description ───────────────────────────────

export function buildDescriptionPrompt(sku, { language = "ro", dimensionsText = null } = {}) {
  console.log(`  [AI Desc] Building prompt for SKU: "${sku}" (lang: ${language})`);
  const lang = getLangConfig(language);

  const dimensionsRule = dimensionsText
    ? `\n11. IMPORTANT: Include these exact product dimensions at the end of the features list: "${dimensionsText}"`
    : "";
  
  const toffRulesBlock = language === "ro" ? `\n${TOFF_RULES_RO}\n\n` : "";

  return `Search Google for EXACTLY "${sku}". 
Search ONLY "${sku}" - do NOT add extra words to the search (no product type, no brand name, no assumptions).
Do NOT assume what type of product it is before seeing the search results.
Find the product on retail websites, manufacturer sites, or product databases.

MANDATORY: Use Google Search with the EXACT query "${sku}" or "${sku} product". Do NOT fabricate information.

You MUST respond with a JSON object in this EXACT format:

If you FOUND the product:
{"found": true, "description": "<the product description>"}

If you did NOT find the product:
{"found": false, "description": ""}

DESCRIPTION RULES (only when found is true):
- ${lang.languageRule}
- Do NOT put any title, heading, "**Name**:", or "Description:". Start DIRECTLY with the descriptive paragraph
- Use <br> tags as line dividers in the output (HTML format)
- Maximum 800 characters total
${toffRulesBlock}EXACT description FORMAT (use <br> for line breaks):

[${lang.elegantSentences}] <br>
<br>
${lang.featuresLabel}: <br>
- [feature 1] <br>
- [feature 2] <br>
- [etc — 6-10 physical details] <br>
<br>
${lang.compositionLabel}: [material composition — MANDATORY, never omit]

STRICT RULES:
1. Respond ONLY with the JSON object, nothing else
2. Do NOT put titles or headings inside the description
3. Start the description DIRECTLY with the descriptive paragraph
4. The descriptive paragraph must be ELEGANT, in fluent natural ${lang.languageName} (no word-for-word translations)
5. Features must be DETAILED (6-10 bullet points)
6. "${lang.compositionLabel}:" is MANDATORY — always include it
7. Use <br> tags for ALL line breaks in the description
8. Maximum 800 characters for the description
9. Do NOT fabricate data. If you cannot find the product, set found to false
10. ${lang.languageRule}${language === "ro" ? `
11. NEVER use the word "premium" or any of the banned words/expressions listed in the TOFF rules above
12. For any animal leather, use only the word "piele" (NEVER "piele de miel/vițel/oaie/cerf"); for crocodile/snake/lizard use "piele exotică"` : ""}${dimensionsRule}`;
}

export async function searchWithGrounding(prompt, maxRetries = 3, { aiClient = genAI, keyLabel = "primary", language = "ro", geminiModel = null } = {}) {
  const lang = getLangConfig(language);
  const systemInstruction = `You are a product search assistant specialized in finding products on the internet.

CRITICAL RULES:
1. You MUST use Google Search for EVERY request. NEVER answer from memory or prior knowledge.
2. When you receive a SKU code, search Google for EXACTLY that code, without adding extra words like brand name, product type, or other assumptions.
3. Your Google search query must be ONLY the exact code (e.g., "A20937-DLC") and optionally "A20937-DLC product". Do NOT add "bag", "shirt", "dress" or any other product type to the search.
4. NEVER assume what type of product it is before searching. Let the Google results tell you what the product is.
5. NEVER invent or fabricate product information. All data must come from real web sources.
6. If you cannot find the product, explicitly say so.
7. ${lang.systemLangRule}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const model = aiClient.getGenerativeModel({
      model: geminiModel || GEMINI_MODEL,
      tools: [{ googleSearch: {} }],
      systemInstruction,
    });

    let finalPrompt = prompt;
    if (attempt > 1) {
      finalPrompt = `IMPORTANT: You MUST use Google Search now. Search ONLY the exact product code, do NOT add extra words. Do NOT answer from memory. Do NOT assume the product type.\n\n${prompt}\n\nYou MUST search Google for ONLY the exact code. Use the Google Search tool NOW.`;
    }

    const result = await geminiWithRetry(() => model.generateContent(finalPrompt), 2);
    const response = result.response;
    const text = response.text();

    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const groundingChunks = groundingMetadata?.groundingChunks || [];
    const groundingSupports = groundingMetadata?.groundingSupports || [];
    const webSearchQueries = groundingMetadata?.webSearchQueries || [];

    const wasGrounded = groundingChunks.length > 0 || groundingSupports.length > 0 || webSearchQueries.length > 0;

    if (wasGrounded) {
      const sources = groundingChunks
        .filter(c => c.web)
        .map(c => ({ title: c.web.title || "unknown", url: c.web.uri || "" }));

      console.log(`  [AI Desc] Grounded on attempt ${attempt} [${keyLabel}] with ${groundingChunks.length} chunks`);
      if (webSearchQueries.length > 0) console.log(`  [AI Desc] Google queries: ${webSearchQueries.join(" | ")}`);
      sources.forEach((s, i) => console.log(`  [AI Desc] Source ${i + 1}: ${s.title} — ${s.url}`));

      let found = false;
      let description = "";
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          found = parsed.found === true;
          description = found ? (parsed.description || "") : "";
        }
      } catch {
        console.log(`  [AI Desc] Could not parse JSON from response, treating as not found`);
      }

      console.log(`  [AI Desc] Product found: ${found}`);

      return {
        text: description,
        found,
        grounded: true,
        sources,
        webSearchQueries,
        groundingChunks,
        attempt,
        usedFallbackKey: keyLabel !== "primary"
      };
    }

    console.log(`  [AI Desc] Attempt ${attempt}/${maxRetries} [${keyLabel}]: No grounding, ${attempt < maxRetries ? 'retrying...' : 'giving up'}`);
  }

  return { text: "", found: false, grounded: false, sources: [], webSearchQueries: [], groundingChunks: [], attempt: maxRetries, usedFallbackKey: keyLabel !== "primary" };
}

// ─── Gemini: Parse & validate search result (structured JSON) ────────

export async function parseSearchResult(product, rawSearchText, { geminiModel = null } = {}) {
  const { title, vendor, image, images } = product;
  const rawImgs = images;
  const imgUrls = Array.isArray(rawImgs)
    ? [...rawImgs]
    : (typeof rawImgs === "string" && rawImgs ? rawImgs.split(",").map(u => u.trim()) : []);
  if (image && !imgUrls.includes(image)) {
    imgUrls.unshift(image);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: geminiModel || GEMINI_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            descriptionAccurate: {
              type: SchemaType.BOOLEAN,
              description: "true if the Google search description accurately matches the real product, false otherwise"
            }
          },
          required: ["descriptionAccurate"]
        }
      }
    });

    const prompt = `Validate this Google search result against the REAL product.

Product title: "${title}"
Brand: "${vendor || "unknown"}"

Google search result:
"""
${rawSearchText.substring(0, 2000)}
"""

Look at ALL the product images carefully and determine if the Google search result describes THIS product:
- descriptionAccurate = true: the description matches what you SEE across ALL images (same product type, same visual appearance, same style). If a brand is mentioned in the description, it must match "${vendor || ""}"
- descriptionAccurate = false: the description does NOT match the images (e.g. search says "bag" but images show a jacket), or mentions a DIFFERENT brand than "${vendor || ""}", or describes a completely different product`;

    const contentParts = [prompt];

    const mainImg = imgUrls[0];
    if (mainImg) {
      try {
        const imageResponse = await fetch(mainImg);
        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.buffer();
          const base64Image = imageBuffer.toString("base64");
          const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
          contentParts.push({ inlineData: { mimeType: contentType, data: base64Image } });
        }
      } catch {}
    }

    const imageCount = contentParts.length - 1;
    console.log(`  [AI Parse] Validating Google description against ${imageCount} image(s) + title`);

    const result = await geminiWithRetry(() => model.generateContent(contentParts));
    const json = JSON.parse(result.response.text());

    console.log(`  [AI Parse] "${title}" → descriptionAccurate: ${json.descriptionAccurate}`);
    return json;
  } catch (error) {
    console.log(`  [AI Parse] Error: ${error.message}, treating as not accurate`);
    return { descriptionAccurate: false };
  }
}

// ─── Gemini: Description from image ──────────────────────────────────

export async function generateDescriptionFromImage(title, imageUrls, { language = "ro", geminiModel = null, dimensionsText = null } = {}) {
  if (!imageUrls || imageUrls.length === 0) {
    console.log(`  [AI Vision] No images available for "${title}"`);
    return null;
  }

  console.log(`  [AI Vision] Generating description from ${imageUrls.length} image(s) for "${title}"`);

  try {
    const imageParts = [];
    const maxImages = 3;
    for (const url of imageUrls.slice(0, maxImages)) {
      try {
        const imageResponse = await fetch(url);
        if (!imageResponse.ok) {
          console.log(`  [AI Vision] Failed to fetch image: ${imageResponse.status} — ${url}`);
          continue;
        }
        const imageBuffer = await imageResponse.buffer();
        const base64Image = imageBuffer.toString("base64");
        const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
        imageParts.push({ inlineData: { mimeType: contentType, data: base64Image } });
      } catch (imgErr) {
        console.log(`  [AI Vision] Skipping image (${imgErr.message}): ${url}`);
      }
    }

    if (imageParts.length === 0) {
      console.log(`  [AI Vision] Could not fetch any images for "${title}"`);
      return null;
    }

    console.log(`  [AI Vision] Loaded ${imageParts.length} image(s)`);

    const lang = getLangConfig(language);
    const model = genAI.getGenerativeModel({ model: geminiModel || GEMINI_MODEL });

    const toffRulesBlock = language === "ro" ? `\n${TOFF_RULES_RO}\n\n` : "";

    const prompt = `You are a luxury fashion copywriter. Look at ALL the product images and use the product title to write an elegant product description.

Product title: "${title}"

IMPORTANT: The response MUST be written in ${lang.languageName} language.
IMPORTANT: Do NOT put any title, heading, "**Name**:", or "Description:". Start DIRECTLY with the descriptive paragraph.
IMPORTANT: Use <br> tags as line dividers in the output (HTML format).
IMPORTANT: Maximum 800 characters total.
${toffRulesBlock}EXACT FORMAT (use <br> for line breaks):

[${lang.elegantSentences}. Describe what you SEE across ALL images.] <br>
<br>
${lang.featuresLabel}: <br>
- [feature 1 — material, color, cut, design] <br>
- [feature 2] <br>
- [etc — 6-10 visible physical details from ALL images] <br>
<br>
${lang.compositionLabel}: [ONLY if you can clearly read the material from a label/tag in the images, or if the product title mentions the material. If you are NOT sure, OMIT this line entirely — do NOT guess.]

STRICT RULES:
1. Do NOT put titles or headings
2. Start DIRECTLY with the descriptive paragraph
3. Describe ONLY what you can see in the images and infer from the title
4. Do NOT guess or invent material composition — include "${lang.compositionLabel}" ONLY if a label/tag is clearly visible OR the product title mentions the material; otherwise OMIT
5. Do NOT invent specific measurements or precise percentages you cannot see
6. The ENTIRE response must be in ${lang.languageName} language
7. Be elegant and sophisticated, in fluent natural ${lang.languageName}
8. Use <br> tags for ALL line breaks
9. Maximum 800 characters total${language === "ro" ? `
10. NEVER use the word "premium" or any of the banned words/expressions listed in the TOFF rules above
11. For any animal leather, use only the word "piele" (NEVER specify the animal); for crocodile/snake/lizard use "piele exotică"` : ""}${dimensionsText ? `\n${language === "ro" ? "12" : "10"}. IMPORTANT: Include these exact product dimensions at the end of the features list: "${dimensionsText}"` : ""}`;

    const result = await geminiWithRetry(() => model.generateContent([prompt, ...imageParts]));

    const text = result.response.text();

    if (text && text.length > 50) {
      console.log(`  [AI Vision] ✓ Generated description from ${imageParts.length} image(s) (${text.length} chars)`);
      return text;
    } else {
      console.log(`  [AI Vision] ✗ Generated text too short or empty`);
      return null;
    }
  } catch (error) {
    console.log(`  [AI Vision] ✗ Error: ${error.message}`);
    return null;
  }
}

// ─── Shopify: Rewrite description from images + existing description ─

export async function rewriteDescriptionFromImage(product, { language = "en", geminiModel = null } = {}) {
  const { title, vendor } = product;
  const existingDescription = product.existingDescription || "";

  const rawImages = product.images;
  const imageList = Array.isArray(rawImages)
    ? rawImages
    : (typeof rawImages === "string" && rawImages ? rawImages.split(",").map(u => u.trim()) : []);
  if (product.image && !imageList.includes(product.image)) {
    imageList.unshift(product.image);
  }

  if (imageList.length === 0 && !existingDescription) {
    console.log(`  [AI Rewrite] No images or description for "${title}"`);
    return null;
  }

  try {
    const imageParts = [];
    for (const url of imageList.slice(0, 3)) {
      try {
        const imageResponse = await fetch(url);
        if (!imageResponse.ok) continue;
        const imageBuffer = await imageResponse.buffer();
        imageParts.push({
          inlineData: {
            mimeType: imageResponse.headers.get("content-type") || "image/jpeg",
            data: imageBuffer.toString("base64")
          }
        });
      } catch {}
    }

    const lang = getLangConfig(language);
    const activeModel = geminiModel || GEMINI_MODEL;

    const hasExisting = existingDescription && existingDescription.trim().length > 20;
    const existingBlock = hasExisting
      ? `\nExisting product description (use as reference for facts, materials, and details — but rewrite completely):\n"""\n${existingDescription.substring(0, 1500)}\n"""\n`
      : "";

    const toffRulesBlock = language === "ro" ? `\n${TOFF_RULES_RO}\n\n` : "";

    const prompt = `You are a luxury fashion copywriter. Write an elegant product description for a high-end online store.

Product title: "${title}"
Brand: "${vendor || "unknown"}"
${existingBlock}
${imageParts.length > 0 ? "Look at the product images to understand the product's appearance, color, cut, and style." : ""}

IMPORTANT: ${lang.languageRule}
IMPORTANT: Do NOT put any title, heading, or "Description:". Start DIRECTLY with the descriptive paragraph.
IMPORTANT: Use <br> tags for line breaks (HTML format).
IMPORTANT: Maximum 800 characters total.
${toffRulesBlock}FORMAT (use <br> for line breaks):

[${lang.elegantSentences}] <br>
<br>
${lang.featuresLabel}: <br>
- [feature 1 — material, color, cut, design] <br>
- [feature 2] <br>
- [etc — 6-10 details] <br>
<br>
${lang.compositionLabel}: [material composition if known from the existing description or clearly visible in images. Otherwise OMIT — do NOT guess.]

RULES:
1. Start DIRECTLY with the descriptive paragraph
2. Be elegant and sophisticated, in fluent natural ${lang.languageName}
3. ${lang.languageRule}
4. Use <br> for ALL line breaks
5. Maximum 800 characters${language === "ro" ? `
6. NEVER use the word "premium" or any of the banned words/expressions listed in the TOFF rules above
7. For any animal leather, use only the word "piele" (NEVER specify the animal); for crocodile/snake/lizard use "piele exotică"` : ""}`;

    const contentParts = [prompt, ...imageParts];

    async function callOnce(generationConfig = null) {
      const modelOpts = { model: activeModel };
      if (generationConfig) modelOpts.generationConfig = generationConfig;
      const m = genAI.getGenerativeModel(modelOpts);
      const result = await geminiWithRetry(() => m.generateContent(contentParts));
      return (result.response.text() || "").trim();
    }

    let text = await callOnce();

    if (looksLikeThinkingLeak(text)) {
      console.log(`  [AI Rewrite] ⚠ Thinking leak detected for "${title}" (head: "${text.slice(0, 60).replace(/\s+/g, " ")}…"), retrying with thinkingBudget=0…`);
      try {
        text = await callOnce(buildNoThinkConfig({ temperature: 0.2 }));
      } catch (retryErr) {
        console.log(`  [AI Rewrite] ✗ Retry failed for "${title}": ${retryErr.message}`);
        return null;
      }
      if (looksLikeThinkingLeak(text)) {
        console.log(`  [AI Rewrite] ✗ Still leaked after retry for "${title}", skipping (no save)`);
        return null;
      }
      console.log(`  [AI Rewrite] ✓ Retry succeeded for "${title}"`);
    }

    if (text && text.length > 50) {
      console.log(`  [AI Rewrite] ✓ Generated description (${text.length} chars, ${imageParts.length} img)`);
      return { text, source: "ai_rewrite" };
    }
    console.log(`  [AI Rewrite] ✗ Response too short`);
    return null;
  } catch (error) {
    console.log(`  [AI Rewrite] ✗ Error: ${error.message}`);
    return null;
  }
}

// ─── TOFF reformat: rewrite an existing description using TOFF rules ─

export async function reformatDescriptionWithToffRules(product, { language = "ro", geminiModel = null } = {}) {
  const activeModel = geminiModel || GEMINI_MODEL;
  const lang = getLangConfig(language);

  const title = product.title || "";
  const vendor = product.vendor || "";
  const currentDescription = (product.currentDescription || "").trim();

  if (!currentDescription || currentDescription.length < 30) {
    console.log(`  [AI Reformat] ✗ Current description too short for "${title}", skipping`);
    return null;
  }

  const rulesBlock = language === "ro" ? `\n${TOFF_RULES_RO}\n\n` : "";

  const prompt = `You are a luxury fashion copywriter for TOFF.ro. You will be given an EXISTING product description and you must REWRITE it to follow the new TOFF style rules. Do NOT lose any factual product detail (material, color, model name, distinguishing features). Do NOT invent new facts that are not in the existing description. Just rewrite the style/wording so it follows the new TOFF rules below.

Product title: "${title}"
Brand: "${vendor}"

EXISTING product description (use this as the SOURCE OF TRUTH for product facts — preserve all factual details, but rewrite the style):
"""
${currentDescription.substring(0, 2500)}
"""

${rulesBlock}OUTPUT FORMAT (use <br> for line breaks — same format as the EXISTING description):

[${lang.elegantSentences}] <br>
<br>
${lang.featuresLabel}: <br>
- [feature 1] <br>
- [feature 2] <br>
- [etc — keep ALL the details from the existing description, but rewritten in fluent natural Romanian] <br>
<br>
${lang.compositionLabel}: [keep the EXACT material composition from the existing description — do NOT change percentages or materials]

STRICT RULES:
1. Do NOT put any title, heading, "**Name**:", or "Description:". Start DIRECTLY with the descriptive paragraph.
2. Preserve EVERY factual detail from the existing description (material, color, cut, hardware, dimensions, model name).
3. Do NOT invent new facts that are not in the existing description.
4. Apply ALL the TOFF rules above (banned words, leather rule, agreement rule, structure).
5. Keep the EXACT material composition from "${lang.compositionLabel}:" line — do NOT alter percentages or materials.
6. Maximum 800 characters total.
7. Use <br> for ALL line breaks.
8. ${lang.languageRule}${language === "ro" ? `
9. NEVER use the word "premium" or any other banned words from the TOFF rules above.
10. For any animal leather, use only "piele" (NEVER "piele de miel/vițel/oaie/cerf"); for crocodile/snake/lizard use "piele exotică".` : ""}

Respond with ONLY the rewritten description, nothing else.`;

  async function callOnce(generationConfig = null) {
    const modelOpts = { model: activeModel };
    if (generationConfig) modelOpts.generationConfig = generationConfig;
    const model = genAI.getGenerativeModel(modelOpts);
    const result = await geminiWithRetry(() => model.generateContent(prompt));
    return (result.response.text() || "").trim();
  }

  try {
    let text = await callOnce();

    if (looksLikeThinkingLeak(text)) {
      console.log(`  [AI Reformat] ⚠ Thinking leak detected for "${title}" (head: "${text.slice(0, 60).replace(/\s+/g, " ")}…"), retrying with thinkingBudget=0…`);
      try {
        text = await callOnce(buildNoThinkConfig({ temperature: 0.2 }));
      } catch (retryErr) {
        console.log(`  [AI Reformat] ✗ Retry failed for "${title}": ${retryErr.message}`);
        return null;
      }
      if (looksLikeThinkingLeak(text)) {
        console.log(`  [AI Reformat] ✗ Still leaked after retry for "${title}", skipping (no save, no push)`);
        return null;
      }
      console.log(`  [AI Reformat] ✓ Retry succeeded for "${title}"`);
    }

    if (text && text.length > 50) {
      console.log(`  [AI Reformat] ✓ Rewrote description for "${title}" (${currentDescription.length}ch → ${text.length}ch)`);
      return { text, source: "ai_reformat" };
    }
    console.log(`  [AI Reformat] ✗ Response too short for "${title}"`);
    return null;
  } catch (error) {
    console.log(`  [AI Reformat] ✗ Error for "${title}": ${error.message}`);
    return null;
  }
}

// ─── TOFF SEO generation (Title + MetaTagDescription) ────────────────

const TOFF_SEO_RULES_RO = `
TOFF SEO RULES (mandatory — Romanian language):

TITLE (page title — VTEX field "Title", maximum 50 characters TOTAL including the suffix):
- Format: "<Tip produs> <Model SAU caracteristică distinctivă>| TOFF.ro"
- The suffix "| TOFF.ro" is MANDATORY at the end (no space before "|", one space after "|").
- Include: product type ALWAYS; model OR a distinctive feature; brand ONLY if it fits in 50 chars total.
- Examples (follow EXACTLY this style):
  • "Pantofi sport Satin Crystal 10| TOFF.ro"
  • "Borsetă din piele| TOFF.ro"
  • "Botine cu toc din piele | TOFF.ro"
  • "Pantofi sport cu inserții lână| TOFF.ro"
- HARD limit: 50 characters total. If too long, drop the brand first, then shorten the model.
- NEVER use the word "premium" or other banned words from TOFF rules.
- For any animal leather use only "piele" (NEVER specify the animal). For crocodile/snake/lizard use "piele exotică".

META DESCRIPTION (VTEX field "MetaTagDescription", between 120 and 160 characters):
- Start with a verb: "Descoperă" / "Descopera".
- Include: product type, a benefit, optional brand, optional demographic ("pentru femei" / "pentru bărbați").
- Include at least one ⭐ separator. You may also use ✓ and ✈ as separators.
- Use 2-3 benefits from this rotating list (vary across products, do NOT always use the same combo):
  • Produs original de la TOFF.ro
  • Produs de lux
  • Livrare gratuită
  • Livrare în 1-2 zile lucrătoare
  • Plată sigură online
  • Retur gratuit
  • Eleganță casual
- HARD limits: between 120 and 160 characters.
- AVOID generic, repetitive phrasing. Make each meta description feel specific to the product (mention the actual type/feature).
- Examples (follow this style):
  • "Descoperă colecția Amina Muaddi pentru femei la TOFF ⭐Produse de lux ✓Pantofi cu toc, sandale ✈Livrare gratuită ✓Plată sigură online"
  • "Descopera pantofi sport cu pietre pentru femei ⭐Produs original de la TOFF.ro ⭐Produs de lux ⭐Livrare in 1-2 zile lucratoare"
  • "Balerini și espadrile Gianvito Rossi la TOFF ⭐Eleganță casual ✈Livrare și retur gratuite ✓Plată sigură online"
  • "Descopera geanta impletita pentru barbati ⭐Produs original de la TOFF.ro ⭐Produs de lux ⭐Livrare in 1-2 zile lucratoare"
- NEVER use "premium" or other banned words from TOFF rules.
`.trim();

export async function generateSEO(product, { language = "ro", geminiModel = null } = {}) {
  const activeModel = geminiModel || GEMINI_MODEL;
  const lang = getLangConfig(language);

  const title = product.title || "";
  const vendor = product.vendor || "";
  const productType = product.productType || product.product_type || "";
  const categories = Array.isArray(product.categories) ? product.categories.join(" > ") : (product.categories || "");
  const demographic = Array.isArray(product.demographics) ? product.demographics[0] : (product.demographic || "");
  const descriptionExcerpt = (product.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);

  const demographicLabel = demographic === "woman" ? "femei" : (demographic === "man" ? "bărbați" : "");

  const rulesBlock = language === "ro" ? TOFF_SEO_RULES_RO : "";

  const prompt = `You are an SEO copywriter for TOFF.ro, a Romanian luxury fashion online store.

Generate the SEO Title and Meta Description for this product.

Product data:
- Title: "${title}"
- Brand: "${vendor}"
- Product type: "${productType}"
- Categories: "${categories}"
- Demographic: "${demographicLabel || "—"}"
- Existing description (for context, do NOT copy verbatim): "${descriptionExcerpt}"

${rulesBlock}

Output: respond ONLY with a JSON object matching the schema. Romanian language. Respect the character limits STRICTLY.`;

  const seoSchema = {
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        title: {
          type: SchemaType.STRING,
          description: "SEO page title in Romanian, max 50 chars total, MUST end with '| TOFF.ro'"
        },
        metaDescription: {
          type: SchemaType.STRING,
          description: "Meta description in Romanian, between 120 and 160 chars, with at least one ⭐ separator"
        }
      },
      required: ["title", "metaDescription"]
    }
  };

  async function callOnce(extraConfig = null) {
    const generationConfig = { ...seoSchema, ...(extraConfig || {}) };
    const m = genAI.getGenerativeModel({ model: activeModel, generationConfig });
    const result = await geminiWithRetry(() => m.generateContent(prompt));
    const raw = result.response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { title: "", metaDescription: "", _raw: raw };
    }
    return { title: (parsed.title || "").trim(), metaDescription: (parsed.metaDescription || "").trim(), _raw: raw };
  }

  try {
    let { title: seoTitle, metaDescription: seoMeta, _raw: rawText } = await callOnce();

    const seoLeak = looksLikeThinkingLeak(seoTitle) || looksLikeThinkingLeak(seoMeta) || looksLikeThinkingLeak(rawText);
    if (seoLeak) {
      console.log(`  [AI SEO] ⚠ Thinking leak detected for "${title}" (title="${seoTitle.slice(0, 40)}…"), retrying with thinkingBudget=0…`);
      try {
        const retry = await callOnce(buildNoThinkConfig({ temperature: 0.2 }));
        seoTitle = retry.title;
        seoMeta = retry.metaDescription;
        rawText = retry._raw;
      } catch (retryErr) {
        console.log(`  [AI SEO] ✗ Retry failed for "${title}": ${retryErr.message}`);
        return null;
      }
      if (looksLikeThinkingLeak(seoTitle) || looksLikeThinkingLeak(seoMeta) || looksLikeThinkingLeak(rawText)) {
        console.log(`  [AI SEO] ✗ Still leaked after retry for "${title}", skipping (no save, no push)`);
        return null;
      }
      console.log(`  [AI SEO] ✓ Retry succeeded for "${title}"`);
    }

    if (seoTitle && !/\|\s*TOFF\.ro$/i.test(seoTitle)) {
      seoTitle = `${seoTitle.replace(/[\s|]+$/, "")}| TOFF.ro`;
    }
    if (seoTitle.length > 50) {
      console.log(`  [AI SEO] ⚠ Title too long (${seoTitle.length}), truncating: "${seoTitle}"`);
      const suffix = "| TOFF.ro";
      seoTitle = seoTitle.slice(0, 50 - suffix.length).replace(/[\s|]+$/, "") + suffix;
    }

    if (seoMeta.length > 160) {
      console.log(`  [AI SEO] ⚠ Meta too long (${seoMeta.length}), truncating to 160`);
      seoMeta = seoMeta.slice(0, 160).trim();
    }
    if (seoMeta.length < 120) {
      console.log(`  [AI SEO] ⚠ Meta too short (${seoMeta.length}) for "${title}"`);
    }

    console.log(`  [AI SEO] ✓ "${title}" → title (${seoTitle.length}ch), meta (${seoMeta.length}ch)`);

    return {
      title: seoTitle,
      metaDescription: seoMeta,
      source: "ai_seo_gemini"
    };
  } catch (error) {
    console.log(`  [AI SEO] ✗ Error for "${title}": ${error.message}`);
    return null;
  }
}

// ─── Core: Generate AI description (L1 search → L2 image) ───────────

function isGrounding429Error(error) {
  const msg = error?.message || "";
  return error?.status === 429
    || msg.includes("429")
    || msg.includes("RESOURCE_EXHAUSTED")
    || msg.includes("rate")
    || msg.includes("quota");
}

export async function generateAIDescription(product, { language = "ro", geminiModel = null } = {}) {
  const activeModel = geminiModel || GEMINI_MODEL;
  const sku = product.sku || null;

  const rawImages = product.images;
  const imageList = Array.isArray(rawImages)
    ? rawImages
    : (typeof rawImages === "string" && rawImages ? rawImages.split(",").map(u => u.trim()) : []);
  if (product.image && !imageList.includes(product.image)) {
    imageList.unshift(product.image);
  }

  let groundingError429 = false;
  let keys429Count = 0;

  // ── Step 1: Google Search + validate against product images ──
  if (sku && groundingClients.length > 0) {
    const prompt = buildDescriptionPrompt(sku, { language, dimensionsText: product.dimensionsText });
    const totalKeys = groundingClients.length;
    const startIdx = groundingRoundRobinIndex;
    groundingRoundRobinIndex = (groundingRoundRobinIndex + 1) % totalKeys;

    for (let i = 0; i < totalKeys; i++) {
      const { client, label } = groundingClients[(startIdx + i) % totalKeys];
      console.log(`  [AI Desc] Searching Google for "${product.title}" using SKU: ${sku} [${label}]`);

      try {
        const result = await searchWithGrounding(prompt, 2, { aiClient: client, keyLabel: label, language, geminiModel: activeModel });

        if (result.grounded && result.found && result.text) {
          console.log(`  [AI Desc] Google found product (${result.text.length} chars), validating...`);
          console.log(`  [AI Desc] Google description:\n${result.text}`);

          const parsed = await parseSearchResult(product, result.text, { geminiModel: activeModel });

          if (parsed.descriptionAccurate) {
            console.log(`  [AI Desc] ✓ Google Search description accepted for "${product.title}" [${label}]`);
            return { text: result.text, source: `google_search_${label}` };
          } else {
            console.log(`  [AI Desc] Google Search rejected (descriptionAccurate: false) [${label}], generating from images...`);
          }
        } else if (result.grounded && !result.found) {
          console.log(`  [AI Desc] Google searched but product not found [${label}], generating from images...`);
        } else {
          console.log(`  [AI Desc] No grounded result [${label}], generating from images...`);
        }
        break;
      } catch (error) {
        if (isGrounding429Error(error)) {
          keys429Count++;
          console.log(`  [AI Desc] ⚠ Grounding 429 on ${label} (${keys429Count}/${totalKeys}): ${error.message}`);
          continue;
        }
        console.log(`  [AI Desc] Google Search error: ${error.message}, generating from images...`);
        break;
      }
    }

    if (keys429Count >= totalKeys) {
      groundingError429 = true;
      console.log(`  [AI Desc] ⚠ All ${totalKeys} grounding keys exhausted (429), falling back to images...`);
    }
  } else if (sku) {
    console.log(`  [AI Desc] No grounding API keys configured, skipping Google Search`);
  } else {
    console.log(`  [AI Desc] No SKU found, skipping Google Search`);
  }

  // ── Step 2: Generate description from images (fallback) ──
  const imageDescription = await generateDescriptionFromImage(product.title, imageList, { language, geminiModel: activeModel, dimensionsText: product.dimensionsText });
  if (imageDescription) {
    const source = groundingError429 ? "ai_image_grounding_429" : "ai_image";
    console.log(`  [AI Desc] ✓ Using image-based description for "${product.title}" (source: ${source})`);
    return { text: imageDescription, source };
  }

  // ── Step 3: Nothing worked ──
  if (groundingError429) {
    console.log(`  [AI Desc] ✗ All methods failed for "${product.title}" (grounding was blocked by 429)`);
    return { text: "", source: "none_grounding_429" };
  }
  console.log(`  [AI Desc] ✗ All methods failed for "${product.title}"`);
  return null;
}
