#!/usr/bin/env node
/**
 * XPERT BEAUTY — Runa product type for every product (runaType, runaDepartment, runaTypeBy)   (2026-11-16)
 *
 * Our own product types (like Fashion Days' main_category): the shop's categories are too broad (products filed under a
 * whole department), too narrow (shampoos split by need) or wrong. The similar-products row compares products of the
 * same runaType.
 *
 * For each product WITHOUT a type (new products after a sync), or all with --force:
 *   1. the rules give a first answer (title first, then the shop category)  — scripts/xpertbeauty-product-types.mjs
 *   2. the AI (Gemini 3.8 Flash) classifies the product blind
 *   3. same answer → done ("rule+ai"); different → one tie-break AI call with both candidates and the description
 *      ("ai-tiebreak"); AI unavailable → the rule's answer ("rule")
 * Writes only runaType, runaDepartment, runaTypeBy on the Product node. Never touches anything else.
 *
 * Usage (from apps/api):
 *   node src/scripts/type-xpertbeauty-products.mjs --dry-run      # show what would be written
 *   node src/scripts/type-xpertbeauty-products.mjs --force --dry-run --max 30   # test the AI path on 30 products, nothing written
 *   node src/scripts/type-xpertbeauty-products.mjs                # type the products that have no type
 *   node src/scripts/type-xpertbeauty-products.mjs --force        # re-type everything (≈ $3 for the whole catalogue)
 * Cost: ≈ $0.0003 per product (Gemini 3.8 Flash, $0.75 / $3.75 per 1M tokens until 2026-12-31) → cents per day.
 */
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");
const T = await import("./xpertbeauty-product-types.mjs");

const STORE = "xpertbeauty.ro";
const DRY = process.argv.includes("--dry-run"), FORCE = process.argv.includes("--force");
const BATCH = 25, CONC = parseInt(process.env.TYPES_CONCURRENCY || "4", 10);

const svc = new Neo4jService(); const driver = svc.getDriver();
const session = driver.session();
try {
  const res = await session.run(`MATCH (p:Product {storeId:$store}) ${FORCE ? "" : "WHERE p.runaType IS NULL"}
    RETURN p.id AS id, p.title AS title, p.category AS category, p.vendor AS brand, substring(coalesce(p.description,''), 0, 350) AS description`, { store: STORE });
  const maxArg = process.argv.indexOf("--max"); const MAX = maxArg > 0 ? parseInt(process.argv[maxArg + 1], 10) : 0;
  const items = res.records.map((r) => r.toObject()).slice(0, MAX || undefined);   // --max N: only the first N (testing)
  console.log(`${items.length} products to type${FORCE ? " (--force: all)" : " (no runaType yet)"}${DRY ? " — DRY RUN" : ""}`);
  if (!items.length) process.exit(0);

  const out = []; let bi = 0;
  const batches = []; for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const worker = async () => { while (bi < batches.length) {
    const b = batches[bi++];
    const input = b.map((x) => ({ id: x.id, title: x.title, shop_category: x.category, brand: x.brand, description: x.description }));
    const ai = await T.aiClassify(input).catch(() => new Map());
    const ties = [];
    for (const x of b) {
      const rule = T.classify(x.title, x.category).type;
      const a = ai.get(x.id); const aiType = a && a.type && a.type !== "alt" ? a.type : null;
      if (!aiType) { out.push({ id: x.id, title: x.title, type: rule !== "necunoscut" ? rule : "accesorii_corp", by: "rule" }); continue; }
      if (rule === aiType || rule === "necunoscut") { out.push({ id: x.id, title: x.title, type: aiType, by: rule === aiType ? "rule+ai" : "ai" }); continue; }
      ties.push({ id: x.id, title: x.title, shop_category: x.category, brand: x.brand, description: x.description, a: rule, b: aiType });
    }
    if (ties.length) {
      const picked = await T.aiTiebreak(ties).catch(() => new Map());
      for (const t of ties) out.push({ id: t.id, title: t.title, type: picked.get(t.id) || t.b, by: picked.has(t.id) ? "ai-tiebreak" : "ai", rule: t.a, ai: t.b });
    }
  } };
  await Promise.all(Array.from({ length: CONC }, worker));

  const by = {}; for (const o of out) by[o.by] = (by[o.by] || 0) + 1;
  console.log(`typed ${out.length}: ${JSON.stringify(by)} · AI ${T.usage.calls} calls, ${T.usage.in} in + ${T.usage.out + T.usage.think} out tokens ≈ $${T.costUSD().toFixed(4)}`);
  for (const o of out.slice(0, DRY ? 40 : 8)) console.log(`  ${o.type.padEnd(20)} ${o.by.padEnd(12)} ${String(o.title || "").slice(0, 70)}${o.rule ? `   (rule ${o.rule} / AI ${o.ai})` : ""}`);
  if (!DRY) {
    const rows = out.map((o) => ({ id: o.id, type: o.type, department: T.DEPARTMENT[o.type] || "Corp", by: o.by }));
    const w = driver.session();
    try { for (let i = 0; i < rows.length; i += 1000) await w.run(`UNWIND $rows AS x MATCH (p:Product {storeId:$store, id:x.id}) SET p.runaType = x.type, p.runaDepartment = x.department, p.runaTypeBy = x.by`, { rows: rows.slice(i, i + 1000), store: STORE }); }
    finally { await w.close(); }
    console.log(`written ${rows.length}`);
  }
} finally { await session.close(); await driver.close(); }
