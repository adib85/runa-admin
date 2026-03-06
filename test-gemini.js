import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = "gemini-3-flash-preview";

const groundingKeys = (process.env.GEMINI_GROUNDING_API_KEYS || "")
  .split(",").map(k => k.trim()).filter(Boolean);
const primaryKey = process.env.GEMINI_API_KEY;

const testGroundingKey = process.env.GEMINI_TEST_GROUNDING_API_KEY;

const allKeys = [
  { key: primaryKey, label: "primary (GEMINI_API_KEY)" },
  ...groundingKeys.map((k, i) => ({ key: k, label: `grounding-${i + 1}` })),
  ...(testGroundingKey ? [{ key: testGroundingKey, label: "test-grounding (new project)" }] : [])
];

async function testKey(apiKey, label) {
  const masked = apiKey ? `${apiKey.substring(0, 10)}...${apiKey.slice(-4)}` : "MISSING";
  console.log(`\n── Testing: ${label} [${masked}] ──`);

  if (!apiKey) {
    console.log(`  SKIPPED — no key`);
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  // Test 1: Simple request (no grounding)
  const t1 = Date.now();
  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent("What is 2+2? Reply with just the number.");
    const ms = Date.now() - t1;
    console.log(`  [simple]    ✓ OK in ${ms}ms — ${result.response.text().trim()}`);
  } catch (error) {
    const ms = Date.now() - t1;
    console.log(`  [simple]    ✗ FAILED in ${ms}ms — ${error.message}`);
  }

  // Test 2: Grounding request
  const t2 = Date.now();
  try {
    const model = genAI.getGenerativeModel({
      model: MODEL,
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(
      `Search Google for "Nike Air Max 90" and give a one-line summary.`
    );
    const ms = Date.now() - t2;
    const metadata = result.response.candidates?.[0]?.groundingMetadata;
    const chunks = metadata?.groundingChunks?.length || 0;
    const queries = metadata?.webSearchQueries || [];
    console.log(`  [grounding] ✓ OK in ${ms}ms — chunks: ${chunks}, queries: ${queries.join(" | ") || "none"}`);
  } catch (error) {
    const ms = Date.now() - t2;
    const is429 = error.status === 429 || error.message?.includes("429") || error.message?.includes("RESOURCE_EXHAUSTED");
    console.log(`  [grounding] ✗ FAILED in ${ms}ms ${is429 ? "[429 RATE LIMITED]" : ""} — ${error.message}`);
  }
}

console.log(`\nModel: ${MODEL}`);
console.log(`Testing ${allKeys.length} API keys...\n`);

for (const { key, label } of allKeys) {
  await testKey(key, label);
}

console.log("\n\nDone.");
