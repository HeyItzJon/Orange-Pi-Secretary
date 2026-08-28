// scripts/diagnose-brightspace.js
//
// One-off: collectBrightspace() reported 0 items from a 962-entry feed —
// this walks the exact same pipeline (parseFeed -> eventToItem ->
// filterRecent) step by step and prints a short count at each stage, so the
// stage that's actually dropping everything is obvious from one screenful
// of output instead of guessing from the collapsed end result.
//
//   node scripts/diagnose-brightspace.js

import "dotenv/config";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseFeed, eventToItem, filterRecent } from "../sources/brightspace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

const url = process.env.BRIGHTSPACE_ICS_URL;
if (!url) {
  console.log("BRIGHTSPACE_ICS_URL not set — nothing to diagnose.");
  process.exit(1);
}

const res = await axios.get(url, { timeout: 20000, responseType: "text" });
const events = parseFeed(res.data);
console.log(`raw VEVENTs parsed:        ${events.length}`);
console.log(`  missing e.uid:           ${events.filter((e) => !e.uid).length}`);
console.log(`  missing e.start:         ${events.filter((e) => !e.start).length}`);
console.log(`  blank/missing summary:   ${events.filter((e) => !(e.summary || "").trim()).length}`);

const items = events.map((e) => eventToItem(e, config)).filter(Boolean);
console.log(`\neventToItem() produced:    ${items.length} usable item(s)`);

const dates = items.map((i) => i.dueAt).filter(Boolean).sort();
if (dates.length) {
  console.log(`  dueAt range:             ${dates[0]}  ..  ${dates[dates.length - 1]}`);
}

const now = new Date();
const maxPastDays = config.brightspace?.maxPastDays ?? 14;
const recent = filterRecent(items, config, now);
console.log(`\nfilterRecent (maxPastDays=${maxPastDays}, now=${now.toISOString().slice(0, 10)}):`);
console.log(`  survives the cutoff:     ${recent.length}`);

const future = items.filter((i) => new Date(i.dueAt).getTime() > now.getTime()).length;
const withinWindow = items.filter((i) => {
  const t = new Date(i.dueAt).getTime();
  return t >= now.getTime() - maxPastDays * 86400000;
}).length;
console.log(`  items with a future dueAt: ${future}`);
console.log(`  items within the window (past+future): ${withinWindow}`);

if (items.length && !recent.length) {
  console.log("\n-> every parsed item is older than maxPastDays and there's nothing upcoming yet.");
  console.log("   If this is expected (between terms, nothing posted for next term yet),");
  console.log("   0 is the correct answer, not a bug.");
} else if (!items.length && events.length) {
  console.log("\n-> eventToItem() is dropping every single raw VEVENT — check the missing-field");
  console.log("   counts above (uid/start/summary) to see which field Brightspace's feed isn't");
  console.log("   actually populating the way this code expects.");
}

if (items.length) {
  const sample = items.slice(0, 3);
  console.log(`\nFirst ${sample.length} item(s) this pass produced (title + dueAt only):`);
  for (const i of sample) console.log(`  - ${i.dueAt}  ${i.title}`);
}
