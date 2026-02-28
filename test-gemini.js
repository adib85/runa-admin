import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
console.log("GEMINI_API_KEY:", apiKey ? `${apiKey.substring(0, 10)}...` : "MISSING");

const genAI = new GoogleGenerativeAI(apiKey);

// Test 1: Simple text request (no Google Search)
async function testBasic() {
  console.log("\n=== TEST 1: Basic text request ===");
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const result = await model.generateContent("Say hello in Romanian, one sentence.");
    console.log("Status: OK");
    console.log("Response:", result.response.text());
  } catch (error) {
    console.log("Status: FAILED");
    console.log("Error:", error.message);
    console.log("Full error:", JSON.stringify(error, null, 2));
  }
}

// Test 2: With Google Search grounding (this is what fails)
async function testGoogleSearch() {
  console.log("\n=== TEST 2: Google Search grounding ===");
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent('Search Google for "Nike Air Max 90" and describe the product.');
    console.log("Status: OK");
    console.log("Response:", result.response.text().substring(0, 200));
    const metadata = result.response.candidates?.[0]?.groundingMetadata;
    console.log("Grounding chunks:", metadata?.groundingChunks?.length || 0);
    console.log("Search queries:", metadata?.webSearchQueries || []);
  } catch (error) {
    console.log("Status: FAILED");
    console.log("Error:", error.message);
    console.log("Full error:", JSON.stringify(error, null, 2));
  }
}

await testBasic();
await testGoogleSearch();
console.log("\nDone.");
