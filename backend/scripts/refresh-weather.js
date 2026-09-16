// scripts/refresh-weather.js
//
// Force an immediate weather pull against the real Open-Meteo API, print
// the decided facts (icon bucket, high/low, precip window, icy-road risk)
// and the summary line, so a change to config.weather's location/units or
// a threshold in sources/weather.js can be checked without waiting for the
// next 15-minute pull.
//
// Run: node scripts/refresh-weather.js

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, getMeta } from "../lib/store.js";
import { collectWeather } from "../sources/weather.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

console.log("pulling real Open-Meteo data...\n");
await collectWeather(config, { force: true });

const w = await getMeta("weather", null);
if (!w) {
  console.log("nothing came back at all — check network access and config.weather.latitude/longitude");
  process.exit(1);
}

console.log(`as of ${w.at}:\n`);
console.log(`  now        ${w.currentTempC}°C, ${w.conditionLabel} (icon: ${w.conditionKey})`);
console.log(`  high/low   ${w.highC}°C / ${w.lowC}°C`);
console.log(
  `  vs yday    ${w.vsYesterday ? `${w.vsYesterday} (yesterday's high was ${w.yesterdayHighC}°C)` : "not available"}`
);
console.log(
  `  peak heat  ${w.peakHeat ? `${w.peakHeat.tempC}°C around ${w.peakHeat.hourLabel}` : "not available"}`
);
console.log(
  `  precip     ${w.precipWindow ? `${w.precipWindow.probabilityPercent}% chance of ${w.precipWindow.kind} ${w.precipWindow.periodLabel}` : "none expected today"}`
);
console.log(`  icy roads  ${w.icyRoadRisk ? "yes" : "no"}`);
// Round 87 — prints the actual per-hour icon list so "why is the wall's
// timeline all one color" can be answered by looking at real data instead
// of guessing: either every hour genuinely IS the same condition today, or
// this list itself already shows the variety and the fix is elsewhere
// (a stale /api/matrix cache, an un-deployed frontend, etc).
console.log(`\n  hourly (${(w.hourlySlots || []).length} slots, 6am-10pm):`);
for (const slot of w.hourlySlots || []) {
  console.log(`    ${slot.hourLabel.padStart(5)}  ${String(slot.tempC).padStart(4)}°C  ${slot.icon}`);
}
console.log(`\nsummary: ${w.summary}`);
console.log(`(as of ${w.summaryAt} — check DEEPSEEK_API_KEY / config.ai.provider if this looks like the rule-based fallback rather than a written sentence)`);
