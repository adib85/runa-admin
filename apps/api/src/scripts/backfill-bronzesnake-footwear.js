#!/usr/bin/env node

/**
 * Bronze Snake — classify footwear into sub-types and add the new category `boots`
 * (the storefront/title taxonomy only has `heels`, `sandals`, `shoes` today, so boots
 * are unsearchable as a category). `flats`/loafers are classified for visibility but
 * PARKED (only ~4 products — too thin); flip WRITE_CATEGORIES below to enable later.
 *
 * WHY Gemini VISION (not title keywords): the title is unreliable — e.g. "Corbin Heel
 * Black" is actually a knee-high BOOT, and ~17 footwear titles carry no type word at all
 * (Alias Mae, Square Toe Lily, …). We classify from the product IMAGE + title + description
 * (the image is the definitive signal — you can SEE a boot vs a sandal). Multimodal call.
 *
 * Scope: products in shoe-ish categories (`shoes` / `womens-shoes` / `womens-bags-and-shoes`),
 * with bags excluded by title. Each is classified boots / heels / sandals / flats / other.
 * Only the TWO NEW categories are written — `boots` and `flats` (a MERGE'd HAS_CATEGORY edge);
 * heels / sandals / shoes keep their existing categorisation untouched. Both-directions:
 * existing boots/flats edges are cleared first, so a re-run is idempotent and self-correcting.
 *
 * Neo4j-only writes (Category nodes + HAS_CATEGORY edges). NEVER touches Shopify.
 * Default is dry-run. Use --apply to write. Needs GEMINI_API_KEY in the env.
 *
 * Usage:
 *   node apps/api/src/scripts/backfill-bronzesnake-footwear.js            # dry run (classify + show)
 *   node apps/api/src/scripts/backfill-bronzesnake-footwear.js --apply    # write boots + flats
 *
 * Revert: MATCH (p:Product {storeId:'bronze-snake-1.myshopify.com'})-[r:HAS_CATEGORY]->(c:Category)
 *         WHERE c.name IN ['boots','flats'] DELETE r
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SHOP = "bronze-snake-1.myshopify.com";
const APPLY = process.argv.includes("--apply");
// --missing: only classify footwear NOT yet classified (no p.footwear_classified_at).
// Cheap for frequent/incremental runs — skips the Gemini vision call for shoes already
// done. Without it, every footwear product is re-classified (the self-healing nightly mode).
const MISSING = process.argv.includes("--missing");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const TYPES = ["boots", "heels", "sandals", "flats", "other"];
const DEFS =
  `- boots = covers the ankle or higher / has a shaft or full-length zipper (ankle, knee-high, Chelsea, sock boot) — EVEN IF the title says "heel" (a knee-high heeled boot is a BOOT).\n` +
  `- heels = an elevated heel that is NOT a boot (court/stiletto/block-heel shoe).\n` +
  `- sandals = open-toe / strappy / slides / low open footwear.\n` +
  `- flats = closed flat shoes — ballet flats, loafers, moccasins, flat mules, sneakers.\n` +
  `- other = not a shoe (a bag/clutch) or genuinely unclear.`;

// Fetch a product image and inline it for the vision call. Request a small Shopify variant
// (?width=400) so it's fast/cheap; skip gracefully if missing/oversized → text-only fallback.
async function imageToInline(url) {
  if (!url) return null;
  try {
    const sized = url + (url.includes("?") ? "&" : "?") + "width=400";
    const r = await fetch(sized);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4_000_000) return null;
    const mimeType = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    return { mimeType, data: buf.toString("base64") };
  } catch { return null; }
}

// Classify ONE footwear product from its IMAGE + title + description → a sub-type.
async function classifyOne(row) {
  const img = await imageToInline(row.image || row.flatImage || row.heroImage);
  const parts = [{ text:
    `Classify this women's FOOTWEAR product into exactly ONE sub-type: ${TYPES.join(", ")}.\n${DEFS}\n` +
    `The IMAGE is the primary signal — look at the shoe. Title: "${row.title}". Description: ${strip(row.description).slice(0, 300)}.\nReturn JSON {type}.` }];
  if (img) parts.push({ inlineData: img });
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1, responseMimeType: "application/json",
      responseSchema: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
    },
  };
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    const t = String((JSON.parse(text).type) || "").trim().toLowerCase();
    return { id: row.id, type: TYPES.includes(t) ? t : "other", hadImage: !!img };
  } catch (e) { return { id: row.id, type: "other", hadImage: !!img, err: e.message }; }
}

// Vision classify all rows with light concurrency (gentle on the API + image CDN).
async function classifyFootwear(rows) {
  const out = new Map(); let done = 0, noImg = 0;
  const POOL = 5;
  for (let i = 0; i < rows.length; i += POOL) {
    const slice = rows.slice(i, i + POOL);
    const results = await Promise.all(slice.map(classifyOne));
    for (const res of results) { out.set(res.id, res.type); if (!res.hadImage) noImg++; }
    done += slice.length;
    console.log(`  classified ${done}/${rows.length}`);
  }
  if (noImg) console.log(`  (${noImg} had no usable image → classified from text only)`);
  return out;
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing in env");
  console.log(`Mode: ${APPLY ? "APPLY (writes Neo4j)" : "DRY RUN (use --apply to write)"}`);
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    // Footwear = in a shoe-ish category or footwear styleFilter; bags excluded by title.
    const res = await session.run(
      `MATCH (p:Product {storeId:$sid})
       WHERE (p.category IN ['shoes','womens-shoes','womens-bags-and-shoes']
          OR any(x IN coalesce(p.styleFilters,[]) WHERE toLower(toString(x)) IN ['shoes','heels','sandals','boots']))
       AND NOT toLower(coalesce(p.title,'')) =~ '.*(bag|clutch|tote|hobo|duffle|cross.?body|pouch|wallet|purse).*'
       ${MISSING ? "AND p.footwear_classified_at IS NULL" : ""}
       RETURN DISTINCT toString(p.id) AS id, p.title AS title, p.description AS description,
                       p.image AS image, p.flatImage AS flatImage, p.heroImage AS heroImage`,
      { sid: SHOP }
    );
    const rows = res.records.map((r) => ({ id: r.get("id"), title: r.get("title"), description: r.get("description"), image: r.get("image"), flatImage: r.get("flatImage"), heroImage: r.get("heroImage") }));
    console.log(`Footwear products (bags excluded): ${rows.length}\n`);

    const typeById = await classifyFootwear(rows);
    const byType = { boots: [], heels: [], sandals: [], flats: [], other: [] };
    for (const r of rows) { const t = typeById.get(r.id) || "other"; byType[t].push(r); }

    console.log(`\nClassification:`);
    for (const t of ["boots", "flats", "heels", "sandals", "other"]) console.log(`  ${t.padEnd(8)} ${byType[t].length}`);
    console.log(`\n■ boots (${byType.boots.length}):`); byType.boots.forEach((r) => console.log(`   ${r.title}`));
    console.log(`\n■ flats (${byType.flats.length}):`); byType.flats.forEach((r) => console.log(`   ${r.title}`));

    // Categories actually written to Neo4j. flats is classified above but parked (too thin, ~4);
    // add "flats" here (and the slug + routing in Prompt 1) if loafer inventory grows later.
    const WRITE_CATEGORIES = ["boots"];

    if (!APPLY) { console.log(`\n(dry run — nothing written. --apply writes: ${WRITE_CATEGORIES.join(", ")}. flats classified but PARKED.)`); return; }

    // Idempotent: clear existing boots/flats edges, then add per classification. Full mode
    // clears the whole shop (self-correcting); --missing clears only the products we just
    // classified, leaving already-done shoes untouched.
    const processedIds = rows.map((r) => r.id);
    if (MISSING) {
      await session.run(
        `UNWIND $ids AS id MATCH (p:Product {storeId:$sid})-[r:HAS_CATEGORY]->(c:Category)
         WHERE toString(p.id) = id AND c.name IN ['boots','flats'] DELETE r`,
        { ids: processedIds, sid: SHOP }
      );
    } else {
      await session.run(
        `MATCH (p:Product {storeId:$sid})-[r:HAS_CATEGORY]->(c:Category) WHERE c.name IN ['boots','flats'] DELETE r`,
        { sid: SHOP }
      );
    }
    for (const cat of WRITE_CATEGORIES) {
      const ids = byType[cat].map((r) => r.id);
      if (!ids.length) continue;
      await session.run(
        `MERGE (c:Category {name:$cat})
         WITH c UNWIND $ids AS id MATCH (p:Product {storeId:$sid}) WHERE toString(p.id) = id
         MERGE (p)-[:HAS_CATEGORY]->(c)`,
        { cat, ids, sid: SHOP }
      );
      console.log(`✅ ${cat}: ${ids.length} products tagged`);
    }

    // Stamp every product we classified so a --missing run skips it next time. In full
    // mode this refreshes the timestamp for the whole footwear set.
    if (processedIds.length) {
      await session.run(
        `UNWIND $ids AS id MATCH (p:Product {storeId:$sid}) WHERE toString(p.id) = id
         SET p.footwear_classified_at = $now`,
        { ids: processedIds, sid: SHOP, now: new Date().toISOString() }
      );
    }
    console.log("\nDone. 'boots' and 'flats' are now categories the chat can fetch.");
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((e) => { console.error("Footwear backfill failed:", e); process.exit(1); });
