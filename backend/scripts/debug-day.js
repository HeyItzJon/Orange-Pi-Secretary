// scripts/debug-day.js
//
// One-off diagnostic: what does the Week page's busy-hours math actually see
// for a given day? Prints every calendar item landing on that day with its
// raw dueAt/meta.end/allDay, plus the clipped {start, end} the week bar
// computes from it — same wakeStart/wakeEnd window weekForecast() uses.
//
// Run: node scripts/debug-day.js [daysFromToday]
//   node scripts/debug-day.js        -> today
//   node scripts/debug-day.js 1      -> tomorrow

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, allItems } from "../lib/store.js";
import { dayKey, hourOfDay } from "../brief/display.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));
const tz = config.timezone || "America/Toronto";
const wakeStart = 7, wakeEnd = 23;

const offset = Number(process.argv[2] || 0);
const now = new Date();
const target = new Date(now.getTime() + offset * 86400000);
const key = dayKey(target, tz);

await init();
const items = await allItems();

const dayItems = items.filter(
  (i) => i.source === "calendar" && i.dueAt && i.kind !== "system" && dayKey(i.dueAt, tz) === key
);

console.log(`\n=== ${key} (offset ${offset}) — ${dayItems.length} calendar item(s) ===\n`);
for (const i of dayItems) {
  const allDay = Boolean(i.meta?.allDay);
  const s = hourOfDay(i.dueAt, tz);
  const rawEndStr = i.meta?.end || null;
  const sameDayEnd = rawEndStr ? dayKey(rawEndStr, tz) === key : null;
  const e = rawEndStr ? hourOfDay(rawEndStr, tz) : null;

  let clippedStart = null, clippedEnd = null, countsAsBusy = false;
  if (!allDay && rawEndStr) {
    countsAsBusy = true;
    clippedStart = Math.max(wakeStart, s);
    const rawEnd = sameDayEnd ? e : wakeEnd;
    clippedEnd = Math.min(wakeEnd, Math.max(clippedStart, rawEnd));
  }

  console.log(`- ${i.title}  [kind:${i.kind} status:${i.status || "open"}]`);
  console.log(`    dueAt:    ${i.dueAt}  (${s.toFixed(2)}h)`);
  console.log(`    meta.end: ${rawEndStr ?? "(none)"}${rawEndStr ? `  (${e.toFixed(2)}h, sameDayEnd=${sameDayEnd})` : ""}`);
  console.log(`    allDay:   ${allDay}`);
  if (countsAsBusy) {
    console.log(`    -> counts as busy ${clippedStart.toFixed(2)}h to ${clippedEnd.toFixed(2)}h (${(clippedEnd - clippedStart).toFixed(2)}h)`);
  } else if (allDay) {
    console.log(`    -> allDay: excluded from busy-hours math entirely (this is the known gap — not counted anywhere yet)`);
  } else {
    console.log(`    -> no meta.end at all: excluded from busy-hours math (never gets clipped/summed)`);
  }
  console.log("");
}
