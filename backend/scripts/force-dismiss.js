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
// IMPORTANT — this script's dismissal skips straight to permanently
// suppressed (lib/store.js's suppressPermanently), on purpose: this is the
// deliberate "I already know I want this specific thing gone now" tool, as
// opposed to a normal /api/items dismiss or the calendar reconciliation
// pass's own automatic guess, either of which only strike-counts toward
// permanence over repeated occurrences (see lib/store.js's dismissItem for
// that model — no single dismiss is instantly permanent EXCEPT through this
// script or the API's own explicit "suppress" action). Matching too loosely
// here is still a real footgun: "test" as a plain substring also matches
// "Test 2" and "Test 3", real events, which then get permanently suppressed,
// not just dismissed until the next refresh. Matching defaults to an EXACT
// title (trimmed, case-insensitive) for that reason — pass --contains to
// opt into the old substring behaviour when you actually want it.
//
// Dismissed something real by mistake? --revive undoes it, using the same
// shape the app's own /api/items/:id/reopen action uses.
//
// Run:
//   node scripts/force-dismiss.js "test"              exact title, dismiss
//   node scripts/force-dismiss.js "test" --contains    substring match
//   node scripts/force-dismiss.js "test" --dry-run     preview only
//   node scripts/force-dismiss.js "Test 2" --revive    undo an accidental dismissal

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, allItems, patchItem, suppressPermanently } from "../lib/store.js";
import { getCalendarList, resolveCalendars, normaliseName } from "../lib/google.js";
import { isEmailLike } from "../lib/classify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const contains = process.argv.includes("--contains");
const revive = process.argv.includes("--revive");
const needle = process.argv[2];
if (!needle || needle.startsWith("--")) {
  console.error('Usage: node scripts/force-dismiss.js "title" [--contains] [--revive] [--dry-run]');
  process.exit(1);
}

await init();

const stored = await allItems();
const target = needle.trim().toLowerCase();
const titleMatches = (t) => {
  const title = (t || "").trim().toLowerCase();
  return contains ? title.includes(target) : title === target;
};

if (revive) {
  // Reviving doesn't need any Google lookup — just find whatever's
  // currently dismissed/done under this title and put it back exactly the
  // way the app's own reopen action would.
  const hits = stored.filter(
    (i) => i.source === "calendar" && i.kind !== "system"
      && (i.status === "dismissed" || i.status === "done")
      && titleMatches(i.title)
  );
  if (!hits.length) {
    console.log(`\nNo dismissed/done calendar item titled ${contains ? "like" : "exactly"} "${needle}" found.`);
    process.exit(0);
  }
  console.log(`\n${hits.length} match(es) to revive for "${needle}":\n`);
  for (const item of hits) {
    console.log(`  - "${item.title}"  (id: ${item.id}, was: ${item.status})`);
    // A clean slate, same as the app's own reopen action: reviving should
    // mean reviving, not "revived but still carrying strikes toward being
    // suppressed again for no new reason."
    if (!dryRun) {
      await patchItem(item.id, {
        status: "open", snoozeUntil: null, surfaceCount: 0,
        dismissStrikes: 0, permanentlySuppressed: false, autoDismissed: false,
      });
    }
  }
  console.log(dryRun ? "\nDry run — nothing changed." : `\nRevived ${hits.length} item(s) — back to open.`);
  process.exit(0);
}

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

const hits = stored.filter(
  (i) => i.source === "calendar" && i.kind !== "system"
    && i.status !== "done" && i.status !== "dismissed"
    && titleMatches(i.title)
);

if (!hits.length) {
  console.log(`\nNo open calendar item titled ${contains ? "like" : "exactly"} "${needle}" found.`);
  process.exit(0);
}

console.log(`\n${hits.length} match(es) for "${needle}"${contains ? " (substring match — double check these are all really meant)" : ""}:\n`);
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

  if (!dryRun) await suppressPermanently(item.id);
}

console.log(
  dryRun
    ? "Dry run — nothing changed."
    : `Permanently suppressed ${hits.length} item(s). This one skips the usual strike-count grace — a refresh will NOT bring these back even if they're still real events on the calendar. Use --revive if that turns out to be wrong for any of them.`
);
