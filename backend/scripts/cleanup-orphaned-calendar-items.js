// scripts/cleanup-orphaned-calendar-items.js
//
// One-time sweep for calendar items stuck from BEFORE reconciliation could
// track them reliably. sources/calendar.js's ongoing reconciliation prefers
// matching a stored item's calendar by its stable Google id (meta.calendarId)
// and only falls back to matching by NAME for anything collected before that
// field existed. An item collected under a calendar's OLD name — exactly
// what renaming calendars during an Apple Calendar -> Google Calendar
// migration produces — has neither a usable id nor a name that still
// matches anything, so ongoing reconciliation has no way to ever catch it:
// it isn't that the fix doesn't run, it's that these specific rows predate
// having enough information on record to be reconciled at all.
//
// This checks every stored calendar item against EVERY calendar Google
// reports right now — not just the ones configured as targets in
// config.json, since an item can be orphaned by a calendar that was
// renamed, deleted, or dropped from targets entirely — and dismisses
// anything that doesn't match any of them by id or name. Nothing here
// touches items still traceable to a real calendar; only ones that don't
// exist anywhere in the account get touched. Ongoing refreshes won't need
// this again: every item collected from here on carries calendarId, which
// survives a rename.
//
// Run: node scripts/cleanup-orphaned-calendar-items.js [--dry-run]

import "dotenv/config";
import { init, allItems, patchItem } from "../lib/store.js";
import { getCalendarList } from "../lib/google.js";
import { isEmailLike } from "../lib/classify.js";
import { logger } from "../lib/log.js";

const log = logger("cleanup");
const dryRun = process.argv.includes("--dry-run");

await init();

const allCalendars = await getCalendarList({ force: true });
// A failed/empty fetch must never be read as "no calendars exist" — that
// would make every stored item look orphaned and wipe the board. Bail
// loudly instead of guessing.
if (!allCalendars.length) {
  log.warn("Google returned zero calendars — refusing to run. Check credentials/network and try again.");
  process.exit(1);
}

const liveNames = new Set(allCalendars.map((c) => (isEmailLike(c.summary) ? "Personal" : c.summary)));
const liveIds = new Set(allCalendars.map((c) => c.id));
log.info(`${allCalendars.length} calendars on record in Google right now`);

const stored = await allItems();
const orphans = [];
for (const prev of stored) {
  if (prev.source !== "calendar" || prev.kind === "system") continue;
  if (prev.status === "done" || prev.status === "dismissed") continue;

  const knownById = Boolean(prev.meta?.calendarId) && liveIds.has(prev.meta.calendarId);
  const knownByName = !prev.meta?.calendarId && liveNames.has(prev.meta?.calendarName);
  if (knownById || knownByName) continue; // still traceable to a real calendar

  orphans.push(prev);
}

if (!orphans.length) {
  console.log("\nNo orphaned calendar items found — nothing to clean up.");
  process.exit(0);
}

console.log(`\n${orphans.length} orphaned calendar item(s) — belong to no calendar Google reports right now:\n`);
for (const prev of orphans) {
  console.log(`  - "${prev.title}"  (calendar on record: ${prev.meta?.calendarName || "unknown"}, dueAt: ${prev.dueAt || "none"})`);
  if (!dryRun) await patchItem(prev.id, { status: "dismissed" });
}

console.log(
  dryRun
    ? `\nDry run — nothing changed. Re-run without --dry-run to dismiss these ${orphans.length} item(s).`
    : `\nDismissed ${orphans.length} item(s). They'll no longer show anywhere in the app.`
);
