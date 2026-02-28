import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "@runa/config";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

// All AI routes require authentication
router.use(authenticate);

/**
 * Helper: Call Gemini with Google Search and verify it actually searched.
 * Retries up to maxRetries times if no grounding metadata is found.
 */
async function searchWithGrounding(genAI, prompt, maxRetries = 3) {
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
      model: config.gemini.model,
      tools: [{ googleSearch: {} }],
      systemInstruction,
    });

    // On retry, make the prompt even more explicit about searching
    let finalPrompt = prompt;
    if (attempt > 1) {
      finalPrompt = `IMPORTANT: You MUST use Google Search now. Search ONLY the exact product code, do NOT add extra words. Do NOT answer from memory. Do NOT assume the product type.\n\n${prompt}\n\nYou MUST search Google for ONLY the exact code. Use the Google Search tool NOW.`;
    }

    const result = await model.generateContent(finalPrompt);
    const response = result.response;
    const text = response.text();

    // Check if Google Search was actually used
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const groundingChunks = groundingMetadata?.groundingChunks || [];
    const groundingSupports = groundingMetadata?.groundingSupports || [];
    const webSearchQueries = groundingMetadata?.webSearchQueries || [];
    const searchEntryPoint = groundingMetadata?.searchEntryPoint;

    const wasGrounded = groundingChunks.length > 0 || groundingSupports.length > 0 || webSearchQueries.length > 0;

    if (wasGrounded) {
      console.log(`[AI Search] SKU search grounded on attempt ${attempt} with ${groundingChunks.length} chunks, ${webSearchQueries.length} queries`);
      return {
        text,
        grounded: true,
        groundingMetadata,
        searchEntryPoint,
        groundingChunks,
        webSearchQueries,
        attempt
      };
    }

    console.log(`[AI Search] Attempt ${attempt}/${maxRetries}: No grounding detected, ${attempt < maxRetries ? 'retrying...' : 'giving up'}`);
  }

  // Last resort: try one final time with a completely different approach
  // Use a pure search query prompt
  console.log(`[AI Search] All ${maxRetries} attempts failed grounding. Trying final fallback...`);

  const fallbackModel = genAI.getGenerativeModel({
    model: config.gemini.model,
    tools: [{ googleSearch: {} }],
    systemInstruction: "You are a product search assistant. You MUST use Google Search for every query. NEVER answer from memory. Search ONLY the exact SKU code given, do NOT add extra words like brand name or product type to the search.",
  });

  const skuCode = prompt.match(/"([^"]+)"/)?.[1] || prompt;
  const fallbackPrompt = `Search Google for EXACTLY: "${skuCode}"
  
Do NOT add any extra words to the search query. Search ONLY for "${skuCode}".
Find this exact product SKU on shopping websites and provide the product details you find. Use Google Search now.`;

  const fallbackResult = await fallbackModel.generateContent(fallbackPrompt);
  const fallbackResponse = fallbackResult.response;
  const fallbackMetadata = fallbackResponse.candidates?.[0]?.groundingMetadata;
  const fallbackChunks = fallbackMetadata?.groundingChunks || [];
  const fallbackQueries = fallbackMetadata?.webSearchQueries || [];
  const fallbackGrounded = fallbackChunks.length > 0 || fallbackQueries.length > 0;

  if (fallbackGrounded) {
    console.log(`[AI Search] Fallback succeeded with grounding`);
  }

  return {
    text: fallbackResponse.text(),
    grounded: fallbackGrounded,
    groundingMetadata: fallbackMetadata,
    searchEntryPoint: fallbackMetadata?.searchEntryPoint,
    groundingChunks: fallbackChunks,
    webSearchQueries: fallbackQueries,
    attempt: maxRetries + 1
  };
}

/**
 * Build the product description prompt
 */
function buildPrompt(sku, additionalContext) {
  return `Search Google for EXACTLY "${sku}". 
Search ONLY "${sku}" - do NOT add extra words to the search (no product type, no brand name, no assumptions).
Do NOT assume what type of product it is (bag, dress, shoes, etc.) before seeing the search results.
Find the product on retail websites, manufacturer sites, or product databases.

MANDATORY: Use Google Search with the EXACT query "${sku}" or "${sku} product". Do NOT fabricate information. Do NOT add extra words to the search.

IMPORTANT: The final response MUST be written in ROMANIAN language.
IMPORTANT: Do NOT put any title, heading, "**Name**:", or "Description:". Start DIRECTLY with the descriptive paragraph.
IMPORTANT: The tone must be elegant, sophisticated, as for a luxury online fashion store. Mention the brand, style, versatility, how the product can be worn/used.
IMPORTANT: Use <br> tags as line dividers in the output (HTML format).
IMPORTANT: Maximum 800 characters total.

EXACT FORMAT (use <br> for line breaks):

[2-3 elegant sentences in Romanian — style, versatility, how to wear] <br>
<br>
Caracteristici: <br>
- [feature 1] <br>
- [feature 2] <br>
- [etc — 6-10 physical details] <br>
<br>
Compoziție produs: [material composition]

Dimensiuni produs: Lungime: [X] cm, Înălțime: [X] cm, Lățime: [X] cm
(ONLY for bags, backpacks, accessories - NOT for clothing or shoes)

REAL EXAMPLES OF DESCRIPTIONS (follow EXACTLY this style, format, and <br> tags):

EXAMPLE 1 - DRESS:
---
Rochia midi cu print Majolica, Dolce&amp;Gabbana, este o piesă care atrage toate privirile grație printului în tonuri de alb și lila, dar și a opțiunii pentru mătasea fină. Talia marcată și modelul de inspirație retro pun în valoare feminitatea lookurilor tale. <br>
<br>
Caracteristici: <br>
- rochie din mătase cu print Majolica (alb și lila) <br>
- model clasic în A <br>
- decolteu cu două bretele late <br>
- talie marcată prin croială <br>
- fermoar la spate <br>
- tiv drept <br>
- lungime până sub linia genunchilor <br>
<br>
Compoziție produs: Mătase 100 %
---

EXAMPLE 2 - SHIRT:
---
Cămașa din bumbac Loewe este o piesă care scoate clasicul model din zona garderobei basic, grație dublelor manșete aplicate pe mâneci. Poate fi purtată într-o ținută casual cu jeans, office, dar și într-un look de seară, dacă o îmbogățești cu o serie de bijuterii supradimensionate cu pietre. <br>
<br>
Caracteristici: <br>
- cămașă albă din bumbac, cu dungi fine <br>
- croială clasică dreaptă <br>
- guler ascuțit la baza gâtului <br>
- mâneci lungi cu rând dublu de manșete <br>
- tiv drept <br>
- un rând de nasturi sidefii <br>
- etichetă cu logo în interior <br>
<br>
Compoziție produs: Bumbac 100%
---

EXAMPLE 3 - JEANS:
---
Blugii indigo Dolce&amp;Gabbana pot fi purtați în diverse stiluri, de la unul clasic, la unul contemporan, având o croială slim-fit ce poate fi integrată în orice garderobă. Nuanțele te ajută să îi asortezi cu piese în tonuri neutre, dar și să creezi un contrast cu tonuri deschise de albastru sau lila. <br>
<br>
Caracteristici: <br>
- pantaloni indigo din denim <br>
- model clasic slim-fit <br>
- talie medie cu găici pentru curea <br>
- două buzunare laterale plate <br>
- două buzunare la spate <br>
- tiv drept <br>
- logo patch metalic aplicat la spate pe buzunar <br>
<br>
Compoziție produs: Bumbac 98%, Elastan 2%
---

EXAMPLE 4 - SHOES:
---
Pantofii oxford navy, Santoni, sunt ideali pentru outfiturile de birou sau de eveniment, având o structură clasică, ușor de încadrat în fiecare garderobă. <br>
<br>
Caracteristici: <br>
- pantofi bleumarin din piele <br>
- model clasic Oxford <br>
- șireturi negre subțiri <br>
- vârf ascuțit lucios <br>
- talpă subțire cu toc mic pătrat <br>
- interior bej din piele <br>
- logo imprimat în interior <br>
<br>
Compoziție produs: Piele 100 %
---

EXAMPLE 5 - JOGGERS:
---
Pantalonii drepți Dolce&amp;Gabbana dau un aer classy perechii de joggers, prin croiala conică la dungă, ce îi transformă într-o pereche ușor de adaptat unor registre diferite. Pot fi asortați cu jachete college sau cu pulovere din cașmir, în nuanțe neutre sau de contrast. <br>
<br>
Caracteristici: <br>
- pantaloni sport negri din bumbac <br>
- model clasic joggers <br>
- talie medie elastică, reglabilă prin șiret <br>
- două buzunare laterale plate <br>
- tiv drept <br>
- logo patch aplicat la spate <br>
<br>
Compoziție produs: Bumbac 59 %, Vâscoză 41%
---

STRICT RULES:
1. Do NOT put titles or headings (no "## Description", no "**Product:**", no "Product name:", nothing)
2. Start DIRECTLY with the descriptive paragraph
3. The descriptive paragraph must be ELEGANT, like a luxury copywriter's text
4. Features must be DETAILED (6-10 bullet points, with all physical details)
5. Include "Dimensiuni produs:" ONLY for bags/backpacks/accessories
6. Include "Compoziție produs:" ALWAYS (leather, cotton, polyester, etc.)
7. Use <br> tags for ALL line breaks
8. Maximum 800 characters total
9. Do NOT include "Cod produs:", "Cod culoare:", "Cod articol:" or any codes
10. Do NOT fabricate data. If you cannot find the product, say in Romanian: "Nu am găsit acest produs pe internet."
11. The ENTIRE product description response must be in ROMANIAN language

${additionalContext ? `Additional context: ${additionalContext}` : ""}`;
}

/**
 * POST /api/ai/product-description
 * Uses Gemini with Google Search grounding to find product descriptions by SKU
 */
router.post("/product-description", async (req, res) => {
  try {
    const { sku, additionalContext } = req.body;

    if (!sku || !sku.trim()) {
      return res.status(400).json({ error: "SKU is required" });
    }

    if (!config.gemini.apiKey) {
      return res.status(500).json({ error: "Gemini API key is not configured. Set GEMINI_API_KEY in your environment." });
    }

    const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    const prompt = buildPrompt(sku.trim(), additionalContext);

    // Search with automatic retry if grounding fails
    const searchResult = await searchWithGrounding(genAI, prompt, 3);

    // Build sources from grounding chunks
    const sources = searchResult.groundingChunks
      .filter(chunk => chunk.web)
      .map(chunk => ({
        title: chunk.web.title || "Unknown",
        url: chunk.web.uri || ""
      }));

    res.json({
      success: true,
      sku: sku.trim(),
      description: searchResult.text,
      sources,
      searchQueries: searchResult.webSearchQueries,
      searchEntryPoint: searchResult.searchEntryPoint?.renderedContent || null,
      grounded: searchResult.grounded,
      attempts: searchResult.attempt,
      warning: !searchResult.grounded
        ? "Atenție: Rezultatul poate să nu fie verificat. Google Search nu a returnat surse web. Verificați manual informațiile."
        : null
    });

  } catch (error) {
    console.error("Error fetching product description:", error);

    if (error.message?.includes("API key")) {
      return res.status(401).json({ error: "Invalid Gemini API key" });
    }
    if (error.message?.includes("quota")) {
      return res.status(429).json({ error: "Gemini API quota exceeded. Please try again later." });
    }

    res.status(500).json({
      error: "Failed to fetch product description",
      details: error.message
    });
  }
});

/**
 * POST /api/ai/product-description-batch
 * Look up descriptions for multiple SKUs at once
 */
router.post("/product-description-batch", async (req, res) => {
  try {
    const { skus } = req.body;

    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: "An array of SKUs is required" });
    }

    if (skus.length > 10) {
      return res.status(400).json({ error: "Maximum 10 SKUs per batch request" });
    }

    if (!config.gemini.apiKey) {
      return res.status(500).json({ error: "Gemini API key is not configured" });
    }

    const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

    const results = [];
    for (const sku of skus) {
      try {
        const prompt = buildPrompt(sku.trim());
        const searchResult = await searchWithGrounding(genAI, prompt, 2);
        const sources = searchResult.groundingChunks
          .filter(chunk => chunk.web)
          .map(chunk => ({ title: chunk.web.title, url: chunk.web.uri }));

        results.push({
          sku: sku.trim(),
          description: searchResult.text,
          sources,
          success: true,
          grounded: searchResult.grounded,
          warning: !searchResult.grounded ? "Rezultat neverificat - fără surse web" : null
        });
      } catch (err) {
        results.push({ sku: sku.trim(), error: err.message, success: false });
      }
    }

    res.json({ success: true, results });

  } catch (error) {
    console.error("Error in batch product description:", error);
    res.status(500).json({ error: "Failed to process batch request", details: error.message });
  }
});

export default router;
