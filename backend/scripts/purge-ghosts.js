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
// Two passes, both aimed at the same rule: a dismissed calendar item is
// only safe to hard-delete if NOTHING could ever recreate it.
//
// PASS 1 — calendar-level. collectCalendar() only ever fetches events from
// calendars listed in config.json's calendar.targets, so:
//
//   - a dismissed item whose calendar is NOT a currently tracked target
//     (either the calendar doesn't exist in Google at all anymore, or it's
//     real but was never/no-longer a target) can never come back from a
//     real refresh — deleting it just makes "gone" mean gone, instead of a
//     permanently hidden row sitting in the database forever.
//   - a dismissed item whose calendar IS a currently tracked target moves
//     on to pass 2 rather than being deleted outright.
//
// PASS 2 — event-level, for anything pass 1 left as "calendar still
// tracked". Deleting an event straight out of Google (not just dismissing
// it in the app) is exactly what Jon does when he wants to fully retire a
// test event, so a dismissed row whose calendar is a live target can still
// be safe to hard-delete — IF the specific event itself is confirmed gone
// too. This fetches live events for just the tracked calendars that own a
// candidate, and rebuilds each event's id the same way collectCalendar()
// does (itemId("calendar", `${calendarId}:${eventId}`) — see lib/ids.js,
// same natural key every time, so this reproduces the exact id already
// sitting in the database without needing the raw Google event id on
// record). A candidate whose id shows up in that live set still has a real
// event behind it — some other dismissal, unrelated to this cleanup, on a
// calendar that just happens to be tracked — and stays protected. A
// candidate whose id doesn't show up has had its underlying event deleted
// from Google directly and can never be recreated by any future refresh,
// so it's just as safe to hard-delete as a pass-1 orphan. A calendar whose
// live fetch fails this run leaves its candidates protected rather than
// guessed at — same "never read a failed fetch as a deletion" rule
// sources/calendar.js's own reconciliation follows.
//
// Items with no calendarId on record (pre-dating that field) and no
// dueAt can't be safely checked this way and stay protected — nothing
// here ever guesses.
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
import { getCalendarList, resolveCalendars, normaliseName, getEvents } from "../lib/google.js";
import { isEmailLike } from "../lib/classify.js";
import { itemId } from "../lib/ids.js";

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

// Pass 1 — calendar-level.
const orphans = dismissed.filter((i) => !isMatchedTarget(i));
const onTrackedCalendar = dismissed.filter((i) => isMatchedTarget(i));

// Pass 2 — event-level, only for candidates pass 1 couldn't already clear:
// dueAt is required (nothing to look up a window around without it), and a
// calendarId is required (the live-set rebuild below is keyed by it).
const checkable = onTrackedCalendar.filter((i) => i.dueAt && i.meta?.calendarId);
const unverifiable = onTrackedCalendar.filter((i) => !i.dueAt || !i.meta?.calendarId);

let confirmedDeletedEvents = [];
let stillLiveEvents = [];
let uncheckedFetchFailed = [];

if (checkable.length) {
  const calendarIdsNeeded = new Set(checkable.map((i) => i.meta.calendarId));
  const calendarsToCheck = matched.filter((c) => calendarIdsNeeded.has(c.id));

  const dueTimes = checkable.map((i) => new Date(i.dueAt).getTime());
  const timeMin = new Date(Math.min(...dueTimes) - 86400000); // a day of padding
  const timeMax = new Date(Math.max(...dueTimes) + 86400000);

  const { events, failedCalendarIds } = await getEvents(calendarsToCheck, { timeMin, timeMax });
  const liveIds = new Set(events.map((e) => itemId("calendar", `${e.calendarId}:${e.id}`)));
  const failedIds = new Set(failedCalendarIds);

  for (const item of checkable) {
    if (failedIds.has(item.meta.calendarId)) {
      uncheckedFetchFailed.push(item);
    } else if (liveIds.has(item.id)) {
      stillLiveEvents.push(item);
    } else {
      confirmedDeletedEvents.push(item);
    }
  }
}

const toDelete = [...orphans, ...confirmedDeletedEvents];
const protectedOnes = [...unverifiable, ...stillLiveEvents, ...uncheckedFetchFailed];

if (!toDelete.length) {
  console.log(
    `\nNo hard-deletable ghosts found. ${dismissed.length} dismissed calendar item(s) total — all still traceable to a live event or unverifiable, left alone.`
  );
  process.exit(0);
}

if (orphans.length) {
  console.log(`\n${orphans.length} dismissed item(s) to hard-delete — calendar is not a currently tracked target:\n`);
  for (const item of orphans) {
    console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"}, dueAt: ${item.dueAt || "none"})`);
  }
}
if (confirmedDeletedEvents.length) {
  console.log(`\n${confirmedDeletedEvents.length} dismissed item(s) to hard-delete — calendar is tracked, but the event itself is confirmed gone from Google:\n`);
  for (const item of confirmedDeletedEvents) {
    console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"}, dueAt: ${item.dueAt || "none"})`);
  }
}
if (!dryRun) {
  for (const item of toDelete) await deleteItem(item.id);
}

if (stillLiveEvents.length) {
  console.log(`\n${stillLiveEvents.length} dismissed item(s) left alone — the event still exists on a tracked calendar (a real, separate dismissal — deleting the row risks it silently reappearing as "open" on the next refresh):`);
  for (const item of stillLiveEvents) {
    console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"})`);
  }
}
if (uncheckedFetchFailed.length) {
  console.log(`\n${uncheckedFetchFailed.length} dismissed item(s) left alone — couldn't confirm their calendar's current events this run (fetch failed), left alone rather than guessed at:`);
  for (const item of uncheckedFetchFailed) {
    console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"})`);
  }
}
if (unverifiable.length) {
  console.log(`\n${unverifiable.length} dismissed item(s) left alone — too old to verify (no calendarId and/or no dueAt on record):`);
  for (const item of unverifiable) {
    console.log(`  - "${item.title}"  (id: ${item.id}, calendar: ${item.meta?.calendarName || "unknown"})`);
  }
}

console.log(
  dryRun
    ? `\nDry run — nothing changed. Re-run without --dry-run to actually delete these ${toDelete.length} item(s).`
    : `\nDeleted ${toDelete.length} item(s) for good.`
);
