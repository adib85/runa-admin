import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
console.log("GEMINI_API_KEY:", apiKey ? `${apiKey.substring(0, 10)}...` : "MISSING");

const genAI = new GoogleGenerativeAI(apiKey);
const MODEL = "gemini-3-flash-preview";

async function singleRequest(label) {
  const start = Date.now();
  try {
    const model = genAI.getGenerativeModel({
      model: MODEL,
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(`Search Google for "Nike Air Max 90 ${label}" and give a one-line summary.`);
    const ms = Date.now() - start;
    console.log(`  [${label}] OK in ${ms}ms — ${result.response.text().substring(0, 80)}...`);
    return { label, ok: true, ms };
  } catch (error) {
    const ms = Date.now() - start;
    console.log(`  [${label}] FAILED in ${ms}ms — ${error.message}`);
    return { label, ok: false, ms, error: error.message };
  }
}

// Test sequential requests
async function testSequential(count) {
  console.log(`\n=== SEQUENTIAL: ${count} requests one by one ===`);
  let ok = 0, fail = 0;
  for (let i = 1; i <= count; i++) {
    const result = await singleRequest(`seq-${i}`);
    result.ok ? ok++ : fail++;
  }
  console.log(`Result: ${ok} OK, ${fail} FAILED\n`);
}

// Test concurrent requests
async function testConcurrent(count) {
  console.log(`\n=== CONCURRENT: ${count} requests at the same time ===`);
  const promises = [];
  for (let i = 1; i <= count; i++) {
    promises.push(singleRequest(`par-${i}`));
  }
  const results = await Promise.all(promises);
  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`Result: ${ok} OK, ${fail} FAILED\n`);
}

// Run tests
console.log(`\nModel: ${MODEL}`);
console.log("Starting tests...\n");

await testSequential(3);
await testConcurrent(2);
await testConcurrent(3);
await testConcurrent(5);
await testConcurrent(10);

console.log("Done.");
