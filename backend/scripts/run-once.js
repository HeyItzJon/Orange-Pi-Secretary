// scripts/run-once.js
//
// Run one full cycle from the terminal and print the brief.
//   npm run brief        — refresh everything, compose, narrate
//   npm run brief:dry    — same, but no AI calls at all
//
// Useful for testing without waiting for the scheduler, and for wiring the
// brief into cron or a Telegram bot later.

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init } from "../lib/store.js";
import { runSources, buildBrief } from "../brief/compose.js";
import { SECTION_LABELS } from "../brief/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes("--dry");
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] || null;

const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));
if (dry) config.ai = { ...config.ai, provider: "off" };

await init();

console.log(`\n=== refreshing ${only || "all sources"}${dry ? " (dry: no AI)" : ""} ===\n`);
const report = await runSources(config, { only });
console.table(report);

const brief = await buildBrief(config, { narrate: !dry });

console.log(`\n${"=".repeat(58)}`);
if (brief.summary) console.log(`\n  ${brief.summary}\n`);
console.log(`  ${brief.counts.total} items · ${brief.counts.new} new · ${brief.counts.hidden} held back`);
console.log(`${"=".repeat(58)}\n`);

for (const [key, list] of Object.entries(brief.sections)) {
  console.log(`${SECTION_LABELS[key].toUpperCase()}`);
  for (const it of list) {
    const flags = [
      it._urgency ? it._urgency.toUpperCase() : null,
      it._new ? "NEW" : null,
      it._changed ? "CHANGED" : null,
      it.surfaceCount > 1 ? `told ${it.surfaceCount}x` : null,
    ].filter(Boolean).join(" ");
    console.log(`  · ${it.title}${flags ? `  [${flags}]` : ""}`);
    if (it.detail) console.log(`      ${it.detail}`);
  }
  console.log("");
}

if (brief.money) {
  const m = brief.money;
  console.log(`MONEY  $${Math.round(m.total).toLocaleString()}  ${m.dayPct >= 0 ? "+" : ""}${m.dayPct.toFixed(2)}% today`);
  console.log("");
}

process.exit(0);
