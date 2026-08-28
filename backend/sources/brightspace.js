// sources/brightspace.js
//
// Brightspace/D2L publishes a per-student "Calendar" as a subscribable .ics
// feed — the same kind of URL you'd paste into Google Calendar or Apple
// Calendar to subscribe to it there. This reads that feed directly instead,
// on the same 15-minute clock as email/calendar/money (see COLLECTORS in
// brief/compose.js), and turns each dated entry into a regular item.
//
// Deliberately a SECONDARY source, never a replacement for Google Calendar:
// see brief/display.js's isTaskLike() (source === "brightspace" is always
// task-like) and buildDeadlinePool() — a Brightspace item only ever lands in
// the Deadlines list, never on the hourly Strip or the Week page's event
// bars (those both filter to source === "calendar" specifically). The
// safety-net "N not on your calendar yet" count (brief/brightspace.js) is
// what actually cross-references the two — this file's only job is turning
// the feed into plain items, the same as sources/calendar.js does for
// Google's events.
//
// No AI here at all — same reasoning sources/calendar.js gives for its own
// lack of one: an assignment's due date already knows what it is.
//
// If BRIGHTSPACE_ICS_URL isn't set in .env yet, this cleanly returns zero
// items with a "not configured" detail line rather than failing the whole
// pull cycle — same "off means off, not an error" shape config.json's own
// ai.provider: "off" already establishes. Run `npm run set-brightspace-url`
// to paste the real feed URL in once you have it.

import ical from "node-ical";
import axios from "axios";
import { logger } from "../lib/log.js";
import { itemId, contentHash } from "../lib/ids.js";
import { categorise, extractCourseCode } from "../lib/classify.js";

const log = logger("brightspace");
const TIMEOUT = 20000;

/**
 * node-ical's own documented signal for a VALUE=DATE entry (a whole calendar
 * day, no time attached — a reading week, a term boundary) vs. a normal
 * VALUE=DATE-TIME. Mirrors how sources/calendar.js reads Google's own
 * separate start.date/start.dateTime fields for the same distinction.
 */
function isAllDay(e) {
  return e.datetype === "date";
}

function toIso(start, allDay) {
  if (!start) return null;
  if (allDay) {
    // A bare calendar-day value, same treatment sources/calendar.js's own
    // dayKey() gives Google's all-day strings — keep it as YYYY-MM-DD, never
    // round-tripped through a timezone conversion that could land on the
    // wrong day.
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, "0");
    const d = String(start.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return start.toISOString();
}

/** Parses one already-fetched ICS string into plain VEVENT objects — split
 *  out from collectBrightspace() so scripts/test-brightspace.js can exercise
 *  real parsing against a small synthetic fixture with no network call. */
export function parseFeed(icsText) {
  const parsed = ical.parseICS(icsText);
  return Object.values(parsed).filter((e) => e.type === "VEVENT");
}

/**
 * Turns one parsed VEVENT into an item, or null for something with no usable
 * due date (a feed can carry non-dated noise; skip it rather than surface a
 * blank deadline). `config` is only used for categorise() — the same rule
 * set every other source classifies against, so an assignment titled
 * "Quiz 3 — ELEC 2507" earns the same "Test" weight a Google Calendar quiz
 * would, purely from matching the same title keywords.
 */
export function eventToItem(e, config) {
  const allDay = isAllDay(e);
  const dueAt = toIso(e.start, allDay);
  if (!dueAt || !e.uid) return null;

  const title = (e.summary || "").trim();
  if (!title) return null;

  const courseCode = extractCourseCode(title) || extractCourseCode(e.description) || null;

  const category = categorise({ title, calendarName: "Brightspace", body: e.description }, config);

  return {
    id: itemId("brightspace", e.uid),
    source: "brightspace",
    title,
    detail: courseCode || category.label,
    url: e.url || null,
    dueAt,
    category: category.id,
    categoryLabel: category.label,
    categoryWeight: category.weight,
    // Brightspace only ever means school — no need to run this through
    // deriveDomain()'s own pattern matching when the answer is never
    // anything else.
    domain: "school",
    courseCode,
    unmissable: Boolean(category.unmissable),
    contentHash: contentHash({ t: title, d: dueAt, desc: e.description || null }),
    meta: {
      allDay,
      description: e.description ? String(e.description).trim().slice(0, 1200) : null,
    },
  };
}

/**
 * A Brightspace .ics feed is typically a subscription to your WHOLE
 * enrollment history, not just the current term — old courses' assignment
 * dates sit in it forever. Nothing else in the pipeline ages these out on
 * its own (see lib/store.js's prune(), which only ever removes done/
 * dismissed items — an old Brightspace item stays "open" indefinitely
 * unless dropped here), so without this a years-old assignment gets
 * re-collected and counted as an open task, and as "not on your calendar",
 * forever. maxPastDays draws the line at "recent enough to still matter."
 * Split out from collectBrightspace() so scripts/test-brightspace.js can
 * exercise the cutoff itself against plain fixture items, no network call.
 */
export function filterRecent(items, config, now = new Date()) {
  const maxPastDays = config.brightspace?.maxPastDays ?? 14;
  const cutoff = now.getTime() - maxPastDays * 86400000;
  return items.filter((i) => new Date(i.dueAt).getTime() >= cutoff);
}

export async function collectBrightspace(config, { force = false, now = new Date() } = {}) {
  const url = process.env.BRIGHTSPACE_ICS_URL;
  if (!url) {
    return { items: [], detail: "not configured — run `npm run set-brightspace-url`" };
  }

  let text;
  try {
    const res = await axios.get(url, { timeout: TIMEOUT, responseType: "text" });
    text = res.data;
  } catch (err) {
    // A dead/rotated subscription URL is a real failure (unlike "not
    // configured" above) — let it throw so runSources() records it as
    // lastError_brightspace, same as any other source's fetch failure.
    throw new Error(`ICS fetch failed: ${err.response?.status || err.code || err.message}`);
  }

  const events = parseFeed(text);
  const rawItems = events.map((e) => eventToItem(e, config)).filter(Boolean);
  const items = filterRecent(rawItems, config, now);

  const courseCount = new Set(items.map((i) => i.courseCode).filter(Boolean)).size;
  const detail = items.length
    ? `${items.length} items${courseCount ? ` from ${courseCount} course${courseCount === 1 ? "" : "s"}` : ""}`
    : "0 items";

  log.info(detail);
  return { items, detail };
}
