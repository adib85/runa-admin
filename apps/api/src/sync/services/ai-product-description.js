import fetch from "node-fetch";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { config as runaConfig } from "@runa/config";
import { geminiWithRetry } from "../utils/index.js";

const GEMINI_MODEL = runaConfig.gemini.model;
const genAI = new GoogleGenerativeAI(runaConfig.gemini.apiKey);

// ─── Gemini: Google Search description ───────────────────────────────

export function buildDescriptionPrompt(sku) {
  console.log(`  [AI Desc] Building prompt for SKU: "${sku}"`);
  
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
- The description MUST be written in ROMANIAN language
- Do NOT put any title, heading, "**Name**:", or "Description:". Start DIRECTLY with the descriptive paragraph
- The tone must be elegant, sophisticated, as for a luxury online fashion store
- Use <br> tags as line dividers in the output (HTML format)
- Maximum 800 characters total

EXACT description FORMAT (use <br> for line breaks):

[2-3 elegant sentences in Romanian — style, versatility, how to wear] <br>
<br>
Caracteristici: <br>
- [feature 1] <br>
- [feature 2] <br>
- [etc — 6-10 physical details] <br>
<br>
Compoziție produs: [material composition]

STRICT RULES:
1. Respond ONLY with the JSON object, nothing else
2. Do NOT put titles or headings inside the description
3. Start the description DIRECTLY with the descriptive paragraph
4. The descriptive paragraph must be ELEGANT, like a luxury copywriter's text
5. Features must be DETAILED (6-10 bullet points)
6. Include "Compoziție produs:" ALWAYS
7. Use <br> tags for ALL line breaks in the description
8. Maximum 800 characters for the description
9. Do NOT fabricate data. If you cannot find the product, set found to false
10. The description MUST be in ROMANIAN language`;
}

export async function searchWithGrounding(prompt, maxRetries = 3) {
  const systemInstruction = `You are a product search assistant specialized in finding products on the internet.

CRITICAL RULES:
1. You MUST use Google Search for EVERY request. NEVER answer from memory or prior knowledge.
2. When you receive a SKU code, search Google for EXACTLY that code, without adding extra words like brand name, product type, or other assumptions.
3. Your Google search query must be ONLY the exact code (e.g., "A20937-DLC") and optionally "A20937-DLC product". Do NOT add "bag", "shirt", "dress" or any other product type to the search.
4. NEVER assume what type of product it is before searching. Let the Google results tell you what the product is.
5. NEVER invent or fabricate product information. All data must come from real web sources.
6. If you cannot find the product, explicitly say so.
7. Your final response (the product description) MUST be written in Romanian language.`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      tools: [{ googleSearch: {} }],
      systemInstruction,
    });

    let finalPrompt = prompt;
    if (attempt > 1) {
      finalPrompt = `IMPORTANT: You MUST use Google Search now. Search ONLY the exact product code, do NOT add extra words. Do NOT answer from memory. Do NOT assume the product type.\n\n${prompt}\n\nYou MUST search Google for ONLY the exact code. Use the Google Search tool NOW.`;
    }

    const result = await geminiWithRetry(() => model.generateContent(finalPrompt));
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

      console.log(`  [AI Desc] Grounded on attempt ${attempt} with ${groundingChunks.length} chunks`);
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
        attempt
      };
    }

    console.log(`  [AI Desc] Attempt ${attempt}/${maxRetries}: No grounding, ${attempt < maxRetries ? 'retrying...' : 'giving up'}`);
  }

  return { text: "", found: false, grounded: false, sources: [], webSearchQueries: [], groundingChunks: [], attempt: maxRetries };
}

// ─── Gemini: Parse & validate search result (structured JSON) ────────

export async function parseSearchResult(product, rawSearchText) {
  const { title, vendor, image } = product;
  const imgUrls = image ? [image] : [];

  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
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

Look at the main product image carefully and determine if the Google search result describes THIS product:
- descriptionAccurate = true: the description matches what you SEE in the image (same product type, same visual appearance, same style). If a brand is mentioned in the description, it must match "${vendor || ""}"
- descriptionAccurate = false: the description does NOT match the image (e.g. search says "bag" but image shows a jacket), or mentions a DIFFERENT brand than "${vendor || ""}", or describes a completely different product`;

    const contentParts = [prompt];

    for (const url of imgUrls) {
      try {
        const imageResponse = await fetch(url);
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

export async function generateDescriptionFromImage(title, imageUrls) {
  if (!imageUrls || imageUrls.length === 0) {
    console.log(`  [AI Vision] No images available for "${title}"`);
    return null;
  }

  console.log(`  [AI Vision] Generating description from ${imageUrls.length} image(s) for "${title}"`);

  try {
    const imageParts = [];
    for (const url of imageUrls) {
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

    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const prompt = `You are a luxury fashion copywriter. Look at ALL the product images and use the product title to write an elegant product description.

Product title: "${title}"

IMPORTANT: The response MUST be written in ROMANIAN language.
IMPORTANT: Do NOT put any title, heading, "**Name**:", or "Description:". Start DIRECTLY with the descriptive paragraph.
IMPORTANT: The tone must be elegant, sophisticated, as for a luxury online fashion store.
IMPORTANT: Use <br> tags as line dividers in the output (HTML format).
IMPORTANT: Maximum 800 characters total.

EXACT FORMAT (use <br> for line breaks):

[2-3 elegant sentences in Romanian — style, versatility, how to wear. Describe what you SEE across ALL images.] <br>
<br>
Caracteristici: <br>
- [feature 1 — material, color, cut, design] <br>
- [feature 2] <br>
- [etc — 6-10 visible physical details from ALL images] <br>
<br>
Compoziție produs: [ONLY if you can read the material from a label/tag in the images, or if the product title mentions the material. Otherwise OMIT this line entirely.]

STRICT RULES:
1. Do NOT put titles or headings
2. Start DIRECTLY with the descriptive paragraph
3. Describe ONLY what you can see in the images and infer from the title
4. Do NOT guess or invent material composition — include "Compoziție produs" ONLY if a label/tag is visible in the images OR the product title mentions the material
4. Do NOT invent specific measurements or precise percentages you cannot see
5. The ENTIRE response must be in ROMANIAN language
6. Be elegant and sophisticated in tone
7. Use <br> tags for ALL line breaks
8. Maximum 800 characters total`;

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

// ─── Core: Generate AI description (L1 search → L2 image) ───────────

export async function generateAIDescription(product) {
  const sku = product.sku
    || product.handle
    || product.title;

  const rawImages = product.images;
  const imageList = Array.isArray(rawImages)
    ? rawImages
    : (typeof rawImages === "string" && rawImages ? rawImages.split(",").map(u => u.trim()) : []);
  if (product.image && !imageList.includes(product.image)) {
    imageList.unshift(product.image);
  }

  // ── Step 1: Google Search + validate against product images ──
  if (sku) {
    console.log(`  [AI Desc] Searching Google for "${product.title}" using SKU: ${sku}`);

    try {
      const prompt = buildDescriptionPrompt(sku);
      const result = await searchWithGrounding(prompt, 2);

      if (result.grounded && result.found && result.text) {
        console.log(`  [AI Desc] Google found product (${result.text.length} chars), validating...`);
        console.log(`  [AI Desc] Google description:\n${result.text}`);

        const parsed = await parseSearchResult(product, result.text);

        if (parsed.descriptionAccurate) {
          console.log(`  [AI Desc] ✓ Google Search description accepted for "${product.title}"`);
          return { text: result.text, source: "google_search" };
        } else {
          console.log(`  [AI Desc] Google Search rejected (descriptionAccurate: false), generating from images...`);
        }
      } else if (result.grounded && !result.found) {
        console.log(`  [AI Desc] Google searched but product not found, generating from images...`);
      } else {
        console.log(`  [AI Desc] No grounded result, generating from images...`);
      }
    } catch (error) {
      console.log(`  [AI Desc] Google Search error: ${error.message}, generating from images...`);
    }
  } else {
    console.log(`  [AI Desc] No SKU found, skipping Google Search`);
  }

  // ── Step 2: Generate description from images (fallback) ──
  const imageDescription = await generateDescriptionFromImage(product.title, imageList);
  if (imageDescription) {
    console.log(`  [AI Desc] ✓ Using image-based description for "${product.title}"`);
    return { text: imageDescription, source: "ai_image" };
  }

  // ── Step 3: Nothing worked ──
  console.log(`  [AI Desc] ✗ All methods failed for "${product.title}"`);
  return null;
}
