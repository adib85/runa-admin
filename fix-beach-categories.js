import dotenv from "dotenv";
dotenv.config();
import neo4j from "neo4j-driver";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-3-flash-preview";

const STORE_ID = "toffro.vtexcommercestable.com.br";

const BEACH_CATEGORIES = [
  "slipi de plajă",
  "sutien de plajă",
  "costum de baie",
  "pantaloni de plajă"
];

async function classifyBeachProduct(title, imageUrl, demographics) {
  if (!imageUrl) {
    console.log(`    [Skip] No image for "${title}"`);
    return null;
  }

  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) return null;

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const base64Image = imageBuffer.toString("base64");
    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            category: { type: SchemaType.STRING, description: "One of: slipi de plajă, sutien de plajă, costum de baie, pantaloni de plajă" }
          },
          required: ["category"]
        }
      }
    });

    const isMan = (demographics || []).includes("man");

    const result = await model.generateContent([
      `Look at this beach/swimwear product image. Classify it into exactly ONE of these categories:
- "slipi de plajă" (swim briefs/bikini bottom)
- "sutien de plajă" (bikini top — only when it's a 2-piece set or just the top)
- "costum de baie" (full swimsuit / one-piece / complete 2-piece set)
- "pantaloni de plajă" (beach shorts/trunks${isMan ? " — common for men" : ""})

Product title: "${title}"
${isMan ? "This is a MEN's product." : ""}
Return exactly one category.`,
      { inlineData: { mimeType: contentType, data: base64Image } }
    ]);

    const parsed = JSON.parse(result.response.text());
    return parsed.category?.toLowerCase()?.trim() || null;
  } catch (error) {
    console.log(`    [Error] Gemini failed for "${title}": ${error.message}`);
    return null;
  }
}

async function main() {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();

  try {
    // Find all products in this store with "de plajă" category
    console.log(`\n[1] Finding "de plajă" products for store ${STORE_ID}...\n`);

    const result = await session.run(
      `MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)-[:HAS_CATEGORY]->(c:Category)
       WHERE toLower(c.name) CONTAINS "de plaj"
       OPTIONAL MATCH (p)-[:HAS_DEMOGRAPHIC]->(d:Demographic)
       RETURN p.id AS id, p.title AS title, p.image AS image, p.handle AS handle,
              collect(DISTINCT c.name) AS categories,
              collect(DISTINCT d.name) AS demographics`,
      { storeId: STORE_ID }
    );

    const products = result.records.map(r => ({
      id: r.get("id"),
      title: r.get("title"),
      image: r.get("image"),
      handle: r.get("handle"),
      categories: r.get("categories"),
      demographics: r.get("demographics")
    }));

    console.log(`Found ${products.length} beach products\n`);

    // Filter out products that already have a specific beach subcategory
    const needsClassification = products.filter(p => {
      const hasSubcategory = p.categories.some(c =>
        BEACH_CATEGORIES.includes(c.toLowerCase())
      );
      return !hasSubcategory;
    });

    console.log(`${needsClassification.length} need classification (${products.length - needsClassification.length} already have subcategory)\n`);

    let updated = 0;
    let failed = 0;

    for (let i = 0; i < needsClassification.length; i++) {
      const p = needsClassification[i];
      console.log(`[${i + 1}/${needsClassification.length}] "${p.title}" (${p.id})`);
      console.log(`    Current categories: ${p.categories.join(", ")}`);
      console.log(`    Demographics: ${p.demographics.join(", ") || "none"}`);

      const subcategory = await classifyBeachProduct(p.title, p.image, p.demographics);

      if (subcategory && BEACH_CATEGORIES.includes(subcategory)) {
        console.log(`    → Classified as: "${subcategory}"`);

        // Add the new category relationship in Neo4j
        await session.run(
          `MATCH (p:Product {id: $productId})
           MERGE (c:Category {name: toLower($category)})
           MERGE (p)-[:HAS_CATEGORY]->(c)
           SET p.category = $category`,
          { productId: p.id, category: subcategory }
        );

        console.log(`    ✓ Saved to Neo4j\n`);
        updated++;
      } else {
        console.log(`    ✗ Could not classify (got: ${subcategory})\n`);
        failed++;
      }

      // Rate limit Gemini calls
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n════════════════════════════════════════`);
    console.log(`Beach category fix complete:`);
    console.log(`  Total beach products:  ${products.length}`);
    console.log(`  Already classified:    ${products.length - needsClassification.length}`);
    console.log(`  Newly classified:      ${updated}`);
    console.log(`  Failed:                ${failed}`);
    console.log(`════════════════════════════════════════\n`);

  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await session.close();
    await driver.close();
  }
}

main();
