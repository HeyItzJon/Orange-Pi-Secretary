// scripts/force-dismiss.js
//
// One-off manual removal for a calendar item that slipped past BOTH ongoing
// reconciliation (sources/calendar.js) and the orphan sweep
// (cleanup-orphaned-calendar-items.js) — plus a diagnosis of WHY it slipped
// through, since dismissing it blind leaves the same gap open for the next
// one.
//
// There's a real gap between the two existing mechanisms:
//   - Ongoing reconciliation only reconciles against calendars listed in
//     config.json's calendar.targets (the "matched" set) — deliberate, so a
//     calendar you've never asked the app to track never gets swept.
//   - The orphan sweep only flags a calendar that doesn't exist ANYWHERE in
//     your Google account — deliberate too, so a real calendar just
//     temporarily unmatched (a fetch failure, say) never gets misread as
//     "gone" and has its items mass-dismissed.
// An item on a calendar that's real but NOT a configured target falls
// through both: reconciliation skips it (not a tracked calendar), and the
// orphan sweep leaves it alone (the calendar it names does exist). This
// prints exactly which case applies for each match, then dismisses them.
//
// Run: node scripts/force-dismiss.js "test" [--dry-run]

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, allItems, patchItem } from "../lib/store.js";
import { getCalendarList, resolveCalendars, normaliseName } from "../lib/google.js";
import { isEmailLike } from "../lib/classify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const needle = process.argv[2];
if (!needle || needle.startsWith("--")) {
  console.error('Usage: node scripts/force-dismiss.js "title substring" [--dry-run]');
  process.exit(1);
}

await init();
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

const allCalendars = await getCalendarList({ force: true });
if (!allCalendars.length) {
  console.error("Google returned zero calendars — refusing to run. Check credentials/network and try again.");
  process.exit(1);
}
const { matched } = await resolveCalendars(config.calendar?.targets || [], { force: true });

const key = (c) => normaliseName(isEmailLike(c.summary) ? "Personal" : c.summary);
const matchedNames = new Set(matched.map(key));
const matchedIds = new Set(matched.map((c) => c.id));
const liveNames = new Set(allCalendars.map(key));
const liveIds = new Set(allCalendars.map((c) => c.id));

const stored = await allItems();
const hits = stored.filter(
  (i) => i.source === "calendar" && i.kind !== "system"
    && i.status !== "done" && i.status !== "dismissed"
    && i.title?.toLowerCase().includes(needle.toLowerCase())
);

if (!hits.length) {
  console.log(`\nNo open calendar item titled like "${needle}" found.`);
  process.exit(0);
}

console.log(`\n${hits.length} match(es) for "${needle}":\n`);
for (const item of hits) {
  const calName = item.meta?.calendarName;
  const calId = item.meta?.calendarId;
  const onRealCalendar = calId ? liveIds.has(calId) : liveNames.has(normaliseName(calName));
  const isTarget = calId ? matchedIds.has(calId) : matchedNames.has(normaliseName(calName));

  console.log(`  - "${item.title}"  (id: ${item.id})`);
  console.log(`      dueAt: ${item.dueAt}`);
  console.log(`      calendar on record: ${calName || "unknown"}${calId ? ` (id: ${calId})` : " (no calendarId on record)"}`);
  console.log(`      that calendar exists in Google right now: ${onRealCalendar}`);
  console.log(`      that calendar is one of config.json's calendar.targets: ${isTarget}`);
  if (onRealCalendar && !isTarget) {
    console.log("      -> THIS is why it was never caught: the calendar it's on is real, but");
    console.log("         isn't in config.json's calendar.targets, so reconciliation never checks");
    console.log("         items on it. Add that calendar to targets if you want it tracked going");
    console.log("         forward — otherwise this one-off dismissal is all it needs.");
  } else if (!onRealCalendar) {
    console.log("      -> its calendar doesn't exist anywhere in Google right now — this should have");
    console.log("         been caught by the orphan sweep. Worth re-running that script; if it still");
    console.log("         doesn't catch this, that's a separate bug worth reporting back.");
  } else {
    console.log("      -> its calendar IS a configured target and still exists — this one is");
    console.log("         unexplained by either known gap and worth reporting back as-is.");
  }
  console.log("");

  if (!dryRun) await patchItem(item.id, { status: "dismissed" });
}

console.log(dryRun ? "Dry run — nothing changed." : `Dismissed ${hits.length} item(s).`);
