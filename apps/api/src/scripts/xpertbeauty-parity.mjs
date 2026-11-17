#!/usr/bin/env node
/**
 * PARITY GATE — golden set (production prompt output, client-approved) vs graph routine candidates.
 * For each golden hero: does the graph routine cover the categories production chose (recall),
 * and are the graph's required steps ones production also used (precision)? Products are compared
 * at CATEGORY level (the prompt's picks are its own judgment; the graph supplies candidates).
 *   node src/scripts/xpertbeauty-parity.mjs [--golden /path/to/golden] [--verbose]
 * Exit 0 always; prints the table + aggregate. Gate we hold ourselves to: recall ≥ 0.85 before any
 * surface reads candidates from the graph instead of the prompt's own knowledge.
 */
import dotenv from "dotenv"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");
const { getComplements } = await import("../graph/xpertbeauty-ops.mjs");
const a = process.argv.slice(2);
const GOLDEN = a.includes("--golden") ? a[a.indexOf("--golden") + 1] : "/Users/adrian/Mobile/xpertbeauty-prompt-lab/golden";
const VERBOSE = a.includes("--verbose");
// category families so "Sampon de par" vs "Sampon pentru par deteriorat" count as the same step kind
// Step-kind normaliser: head noun before " de " / " pentru " / " si ", with a few compounds kept distinct.
const KEEP = ["balsam fara clatire", "ser si crema antirid", "crema si lotiune pentru plaja", "masti si gomaje pentru ten", "creme si tratamente pentru ten", "sampon si balsam barbati"];
const fam = (c) => {
  const x = (c || "").toLowerCase().trim();
  const k = KEEP.find(k => x.startsWith(k)); if (k) return k;
  return x.split(/ (de|pentru|si) /)[0].replace(/^oja si lac.*/, "oja").replace(/^creme?$/, "crema");
};
const driver = new Neo4jService().getDriver();
const rows = []; let sumR = 0, sumP = 0, n = 0, noRoutine = 0, noRitual = 0;
try {
  for (const f of fs.readdirSync(GOLDEN).filter(x => x.endsWith(".json") && !x.startsWith("_"))) {
    const g = JSON.parse(fs.readFileSync(path.join(GOLDEN, f), "utf8"));
    if (g.error || g.noRitual) { noRitual++; continue; }
    const heroId = g.hero?.id || f.replace(/\.json$/, "");
    let out; try { out = await getComplements(driver, heroId, { perStep: 5 }); } catch (e) { rows.push({ heroId, title: g.hero?.title, err: e.message }); continue; }
    if (!out.routine) { noRoutine++; rows.push({ heroId, title: g.hero?.title, routine: "(none)", recall: 0, precision: 0, prod: g.steps.map(s => s.category), graph: [] }); continue; }
    const prod = [...new Set(g.steps.map(s => fam(s.category)))];
    const graphAll = [...new Set(out.steps.flatMap(st => st.categories.map(fam)))];
    const graphReq = [...new Set(out.steps.filter(st => !st.optional).flatMap(st => st.categories.map(fam)))];
    const covered = prod.filter(c => graphAll.includes(c));
    const recall = prod.length ? covered.length / prod.length : 1;
    const precision = graphReq.length ? graphReq.filter(c => prod.includes(c)).length / graphReq.length : 1;
    sumR += recall; sumP += precision; n++;
    rows.push({ heroId, title: g.hero?.title, routine: out.routine.key, recall, precision, prod: g.steps.map(s => s.category), graph: out.steps.map(st => (st.optional ? "(" : "") + st.categories[0] + (st.optional ? ")" : "")), missing: prod.filter(c => !graphAll.includes(c)) });
  }
} finally { await driver.close(); }
for (const r of rows) {
  if (r.err) { console.log(`✗ ${r.heroId} ${r.title} — ERROR ${r.err}`); continue; }
  const flag = r.recall >= 0.85 ? "✓" : r.recall >= 0.5 ? "~" : "✗";
  console.log(`${flag} R=${r.recall.toFixed(2)} P=${r.precision.toFixed(2)}  ${r.title?.slice(0, 55)}  [${r.routine}]`);
  if (VERBOSE || r.recall < 0.85) console.log(`     prod : ${r.prod.join(" | ")}\n     graph: ${r.graph.join(" | ")}${r.missing?.length ? "\n     MISSING in graph: " + r.missing.join(" | ") : ""}`);
}
console.log(`\nheroes compared: ${n} | production had no ritual: ${noRitual} | graph had no routine: ${noRoutine}`);
console.log(`avg category RECALL (production steps covered by graph): ${(sumR / Math.max(n, 1)).toFixed(2)}   avg PRECISION (graph required steps used by production): ${(sumP / Math.max(n, 1)).toFixed(2)}`);
