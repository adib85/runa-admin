#!/usr/bin/env node
// CLI: node src/scripts/xpertbeauty-complements.mjs <heroId> [--profile par_vopsit] [--per 3]
import dotenv from "dotenv"; import path from "path"; import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const { Neo4jService } = await import("../sync/services/neo4j.js");
const { getComplements } = await import("../graph/xpertbeauty-ops.mjs");
const a = process.argv.slice(2); const heroId = a[0]; const profile = a.includes("--profile") ? a[a.indexOf("--profile") + 1] : null; const per = a.includes("--per") ? parseInt(a[a.indexOf("--per") + 1], 10) : 3;
const driver = new Neo4jService().getDriver();
try {
  const out = await getComplements(driver, heroId, { profile, perStep: per });
  console.log(`HERO: ${out.hero.title} [${out.hero.category}] ${out.hero.price} RON line=${out.hero.line || "-"}${profile ? "  PROFILE=" + profile : ""}`);
  console.log(`ROUTINE: ${out.routine?.key || "(none)"} (${out.routine?.pickedBy || "-"})`);
  for (const st of out.steps) {
    console.log(`  step ${st.order}${st.optional ? " (optional)" : ""} — ${st.productHint}  → [${st.categories.join(" | ")}]`);
    for (const c of st.candidates) console.log(`     ${c.score.toFixed(2)}  ${c.title} (${c.category}, ${c.price} RON)  ← ${c.reasons.join("; ")}`);
    if (!st.candidates.length) console.log("     (no in-stock candidates)");
  }
} finally { await driver.close(); }
