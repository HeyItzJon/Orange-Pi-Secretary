// brief/brightspace.js
//
// The safety-net half of the Brightspace feature (the other half, syllabus
// enrichment, lives in brief/detail.js's buildFacts() — see that file's own
// comment). This is deliberately the opposite shape of the calendar's own
// reconciliation pass in sources/calendar.js: nothing here ever writes
// anything back to the store. It's a pure, cheap, read-only comparison —
// same "AI-free, no-network function of already-collected data" contract
// brief/display.js's own buildDisplay() follows — computed fresh on every
// call rather than cached, since matching a handful of Brightspace items
// against a handful of calendar items by course code and date is nowhere
// near expensive enough to need the once-per-compose caching an AI call
// would (see brief/insights.js for what DOES need that).
//
// The question this answers: "of the Brightspace deadlines coming up, how
// many have NO matching entry on my own Google Calendar yet?" — the number
// worth knowing is not "how many Brightspace items exist" (Brightspace is
// never the primary record, see sources/brightspace.js's own header) but
// "how many of these have I not actually put on my calendar", since that's
// the one Google Calendar itself can't tell you.

import { extractCourseCode } from "../lib/classify.js";

const DAY = 86400000;

/**
 * True when some calendar item shares this Brightspace item's course code
 * and falls within `matchWindowMs` of its due date — "same assignment,
 * slightly different stated time" is common enough (an 11:59pm Brightspace
 * cutoff vs. a 11pm calendar reminder you made yourself) that an exact
 * timestamp match would false-flag things that are actually already tracked.
 * A calendar item's own course code is read the same way a Brightspace
 * item's is (extractCourseCode() on its title) when it doesn't already carry
 * one — nothing about a plain Google Calendar event names its course code
 * as a first-class field.
 */
function hasCalendarMatch(bsItem, calendarItems, matchWindowMs) {
  if (!bsItem.courseCode) return false; // nothing to match on — see unscheduledCount()'s own comment
  const due = new Date(bsItem.dueAt).getTime();
  return calendarItems.some((cal) => {
    if (!cal.dueAt) return false;
    const calCode = cal.courseCode || extractCourseCode(cal.title);
    if (calCode !== bsItem.courseCode) return false;
    return Math.abs(new Date(cal.dueAt).getTime() - due) <= matchWindowMs;
  });
}

/**
 * How many upcoming (within `config.brightspace.auditWindowDays`, default
 * 14) Brightspace deadlines have no matching calendar entry. Takes the same
 * `live` (not done/dismissed/snoozed) item list buildDisplay() already has
 * on hand — see filterLive() in this same file.
 *
 * A Brightspace item with no extractable course code can never be matched
 * (there's nothing safe to match it ON) and so always counts as
 * unscheduled — the conservative default for a safety net: better to flag
 * something that's actually already on the calendar under an unmatchable
 * title than to silently drop it from the count.
 */
export function unscheduledCount(live, config, now = new Date()) {
  const cfg = config.brightspace || {};
  const auditWindowMs = (cfg.auditWindowDays ?? 14) * DAY;
  const matchWindowMs = (cfg.courseCodeMatchWindowDays ?? 2) * DAY;
  const horizon = now.getTime() + auditWindowMs;

  const bsItems = live.filter((i) => i.source === "brightspace" && i.dueAt);
  if (!bsItems.length) return 0;

  const calendarItems = live.filter((i) => i.source === "calendar" && i.dueAt);

  let count = 0;
  for (const bs of bsItems) {
    const due = new Date(bs.dueAt).getTime();
    if (Number.isNaN(due) || due > horizon) continue;
    if (!hasCalendarMatch(bs, calendarItems, matchWindowMs)) count++;
  }
  return count;
}
