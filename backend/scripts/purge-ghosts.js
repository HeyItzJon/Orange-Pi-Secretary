// scripts/purge-ghosts.js
//
// Hard-delete for the calendar ghosts this session's cleanup already found.
// cleanup-orphaned-calendar-items.js and force-dismiss.js only ever
// patchItem(id, { status: "dismissed" }) — the row stays in the database,
// just marked to never surface. That's the right default for anything
// dismissed in ordinary day-to-day use (see the scope note below), but Jon
// asked for the actual mistakes — the test/ghost events from this
// migration cleanup — to be deleted from the app, not just silenced.
//
// Scope, and why it's drawn here: a dismissed calendar item is only safe to
// hard-delete if NOTHING could ever recreate it. collectCalendar() only
// ever fetches events from calendars listed in config.json's
// calendar.targets, so:
//
//   - a dismissed item whose calendar is NOT a currently tracked target
//     (either the calendar doesn't exist in Google at all anymore, or it's
//     real but was never/no-longer a target) can never come back from a
//     real refresh — deleting it just makes "gone" mean gone, instead of a
//     permanently hidden row sitting in the database forever.
//   - a dismissed item whose calendar IS a currently tracked target is left
//     alone here, on purpose. Deleting that row would let the next refresh
//     upsert it fresh with status "open" (upsertItem only preserves status
//     for a row that already exists — see lib/store.js) — silently undoing
//     a dismissal that might be completely intentional, made in ordinary
//     use, nothing to do with this session's calendar migration mess.
//     Those stay soft-dismissed; prune() already reclaims them after 90
//     days untouched, and force-dismiss.js --revive is the tool if one of
//     them needs to come back sooner.
//
// This only ever touches status === "dismissed" — never "done". Every item
// the app displays comes from a matched target calendar, so a "done" row
// is always on a protected calendar anyway; excluding it outright is just
// one less thing to reason about.
//
// Run:
//   node scripts/purge-ghosts.js --dry-run     preview only
//   node scripts/purge-ghosts.js               actually deletes

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, allItems, deleteItem } from "../lib/store.js";
import { getCalendarList, resolveCalendars, normaliseName } from "../lib/google.js";
import { isEmailLike } from "../lib/classify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

await init();

const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

const allCalendars = await getCalendarList({ force: true });
// A failed/empty fetch must never be read as "no calendars are tracked" —
// that would make every dismissed item look deletable. Bail loudly instead
// of guessing, same as cleanup-orphaned-calendar-items.js.
if (!allCalendars.length) {
  console.error("Google returned zero calendars — refusing to run. Check credentials/network and try again.");
  process.exit(1);
}
const { matched } = await resolveCalendars(config.calendar?.targets || [], { force: true });

const key = (c) => normaliseName(isEmailLike(c.summary) ? "Personal" : c.summary);
const matchedIds = new Set(matched.map((c) => c.id));
const matchedNames = new Set(matched.map(key));

function isMatchedTarget(item) {
  const calId = item.meta?.calendarId;
  const calName = item.meta?.calendarName;
  return calId ? matchedIds.has(calId) : matchedNames.has(normaliseName(calName));
}

const stored = await allItems();
const dismissed = stored.filter(
  (i) => i.source === "calendar" && i.kind !== "system" && i.status === "dismissed"
);

const toDelete = dismissed.filter((i) => !isMatchedTarget(i));
const protectedOnes = dismissed.filter((i) => isMatchedTarget(i));

if (!toDelete.length) {
  console.log(
    `\nNo hard-deletable ghosts found. ${dismissed.length} dismissed calendar item(s) total, all on currently-tracked calendars — left alone.`
  );
  process.exit(0);
}

console.log(`\n${toDelete.length} dismissed calendar item(s) to hard-delete (calendar is not a currently tracked target):\n`);
for (const item of toDelete) {
  console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"}, dueAt: ${item.dueAt || "none"})`);
  if (!dryRun) await deleteItem(item.id);
}

if (protectedOnes.length) {
  console.log(
    `\n${protectedOnes.length} other dismissed calendar item(s) left alone — their calendar is still a tracked target, so deleting the row risks it silently reappearing as "open" on the next refresh:`
  );
  for (const item of protectedOnes) {
    console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"})`);
  }
}

console.log(
  dryRun
    ? `\nDry run — nothing changed. Re-run without --dry-run to actually delete these ${toDelete.length} item(s).`
    : `\nDeleted ${toDelete.length} item(s) for good.`
);
