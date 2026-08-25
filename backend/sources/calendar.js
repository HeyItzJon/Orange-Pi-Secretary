// sources/calendar.js
//
// Calendar events become items directly. No AI — an event already knows what
// it is, and asking a model to restate it was pure cost in v1.
//
// The detail line is the thing worth getting right. It must EARN its space:
// the title is already on screen, the time is already in the left column, and
// the category is already a chip. So the detail shows only what none of those
// carry — what you wrote in the event description, how long it runs, where it
// is, who else is coming.
//
// It never prints the calendar's own name. For the default calendar that name
// is your email address, which tells you nothing.

import { logger } from "../lib/log.js";
import { resolveCalendars, getEvents } from "../lib/google.js";
import { itemId, contentHash } from "../lib/ids.js";
import { categorise, deriveDomain, isEmphasised, isEmailLike, calendarSwatch, durationLabel } from "../lib/classify.js";
import { allItems, patchItem } from "../lib/store.js";

const log = logger("calendar");

export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(date));
}

export function timeLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(date)).replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);
}

/**
 * Google descriptions arrive as HTML with boilerplate (Meet links, "view your
 * event at..."). Pull the first line that's actually a human note.
 */
export function usefulNote(description, { maxLength = 96 } = {}) {
  if (!description) return null;
  const text = String(description)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  const noise = /^(https?:\/\/|-{3,}|_{3,}|join |dial |meeting id|passcode|view your event|this invitation|do not edit)/i;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 3) continue;
    if (noise.test(line)) continue;
    if (/^[\W_]+$/.test(line)) continue;
    return line.length > maxLength ? `${line.slice(0, maxLength - 1).trimEnd()}…` : line;
  }
  return null;
}

export async function collectCalendar(config, { force = false } = {}) {
  const cfg = config.calendar || {};
  const tz = config.timezone || "America/Toronto";
  const horizonDays = cfg.horizonDays ?? 14;

  const { matched, missing, available } = await resolveCalendars(cfg.targets || [], { force });
  if (!matched.length) {
    log.warn(`no target calendars resolved. Available: ${available.join(" | ")}`);
    return [];
  }
  log.info(`${matched.length} calendars: ${matched.map((c) => c.summary).join(", ")}`);

  const now = new Date();
  const timeMin = new Date(now.getTime() - 2 * 3600000); // catch events already running
  const timeMax = new Date(now.getTime() + horizonDays * 86400000);

  const { events, failedCalendarIds } = await getEvents(matched, { timeMin, timeMax });
  log.info(`${events.length} events over ${horizonDays} days`);
  if (failedCalendarIds.length) {
    const names = matched.filter((c) => failedCalendarIds.includes(c.id)).map((c) => c.summary);
    log.warn(`fetch failed for: ${names.join(", ")} — skipping deletion cleanup for them this round`);
  }

  const todayKey = dayKey(now, tz);
  const items = [];

  for (const e of events) {
    const isToday = dayKey(e.start, tz) === todayKey;
    const category = categorise(
      { title: e.summary, calendarName: e.calendarName, body: e.description },
      config
    );
    const emphasised = isEmphasised(e.summary);
    const domain = deriveDomain(
      { title: e.summary, calendarName: e.calendarName, body: e.description, category: category.id },
      config
    );

    // Only facts the rest of the row doesn't already show.
    const note = usefulNote(e.description);
    const detail = [
      note,
      isToday ? null : timeLabel(e.start, tz),
      durationLabel(e.start, e.end, e.allDay),
      e.location ? e.location.split(",")[0].trim().slice(0, 40) : null,
      e.attendees > 1 ? `${e.attendees} people` : null,
    ].filter(Boolean).join(" · ");

    items.push({
      id: itemId("calendar", `${e.calendarId}:${e.id}`),
      source: "calendar",
      kind: isToday ? "today" : "upcoming",
      title: e.summary,
      detail,
      url: e.htmlLink,
      dueAt: e.start,
      category: category.id,
      categoryLabel: category.label,
      categoryWeight: category.weight,
      domain,
      swatch: calendarSwatch({ calendarName: e.calendarName, category: category.id }),
      // The calendar's own real Google colour (its backgroundColor from
      // calendarList), when Google has one on file — which is effectively
      // always. This is what the day strip and week bars paint with now;
      // swatch above stays only as the fallback for the rare item with no
      // colour on record (an old row from before this field existed).
      color: e.calendarColor || null,
      unmissable: Boolean(category.unmissable),
      emphasised,
      tier: category.id,
      reasons: [category.why, emphasised ? "written in caps" : null].filter(Boolean),
      contentHash: contentHash({ s: e.summary, st: e.start, en: e.end, l: e.location, d: note }),
      meta: {
        calendarName: isEmailLike(e.calendarName) ? "Personal" : e.calendarName,
        // The calendar's real Google id, stable across a rename — unlike
        // calendarName above, which is a display string that changes the
        // moment you rename a calendar. Reconciliation below prefers this
        // when it's on record; see the comment there for why the name alone
        // isn't reliable enough during exactly the kind of calendar
        // reshuffling a migration involves.
        calendarId: e.calendarId,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        attendees: e.attendees,
        recurring: Boolean(e.recurringEventId),
        needsPrep: Boolean(note) || e.attendees > 1,
      },
    });
  }

  // A same-day-collision detector used to live here: a synthetic "X overlaps
  // Y" item per overlapping pair, meant to highlight the clash on the day
  // strip. It went through three rounds trying to make that highlight read
  // clearly on screen — sized to the real overlap window, excluded from the
  // NOW/NEXT hero and "Rest of today", excluded from the week page's
  // eventCount — and along the way it also crashed a live refresh entirely
  // (a raw Date object where every other item carries a plain ISO string,
  // bound straight into a SQLite parameter). Retired rather than patched a
  // fourth time: the two real events it was describing already show their
  // own overlap by literally overlapping on the strip, which is the whole
  // reason the block-separator seam and the tap/hover card exist.

  // Reconcile: an event that's gone from Google (deleted, or moved off a
  // matched calendar) needs to stop showing here too, not linger forever —
  // nothing before this ever removed a calendar item once it was written, so
  // a deleted event stayed "open" and due in the future permanently. Only
  // reconcile against calendars that actually returned fresh data this round
  // (see failedCalendarIds above) — a calendar that failed to fetch must
  // never be read as "every one of its events just got deleted".
  //
  // Matched by calendar ID, not name, when a stored item has one on record
  // (see meta.calendarId above) — a calendar's Google id never changes, but
  // its display name does the moment you rename it, and matching purely by
  // name meant a renamed-or-recreated calendar (exactly what a migration
  // like moving everything from Apple Calendar into Google involves) could
  // silently fall out of every future round's reconciliation: an item
  // stored under the calendar's old name would never match the new name in
  // okCalendarNames again, so a real deletion on that calendar would never
  // get noticed. ID-matching doesn't have that problem. Name is still the
  // fallback for anything collected before this field existed.
  const ok = matched.filter((c) => !failedCalendarIds.includes(c.id));
  const okCalendarIds = new Set(ok.map((c) => c.id));
  const okCalendarNames = new Set(ok.map((c) => (isEmailLike(c.summary) ? "Personal" : c.summary)));
  if (okCalendarIds.size) {
    const liveIds = new Set(items.map((i) => i.id));
    const stored = await allItems();
    for (const prev of stored) {
      if (prev.source !== "calendar" || prev.kind === "system") continue;
      if (prev.status === "done" || prev.status === "dismissed") continue;
      const calendarOk = prev.meta?.calendarId
        ? okCalendarIds.has(prev.meta.calendarId)
        : okCalendarNames.has(prev.meta?.calendarName);
      if (!prev.dueAt || !calendarOk) continue;
      const dueTime = new Date(prev.dueAt).getTime();
      if (dueTime < timeMin.getTime() || dueTime > timeMax.getTime()) continue;
      if (liveIds.has(prev.id)) continue;
      await patchItem(prev.id, { status: "dismissed" });
      log.info(`"${prev.title}" no longer on the calendar — marked dismissed`);
    }
  }

  if (missing.length) {
    items.push({
      id: itemId("calendar", `missing:${missing.join(",")}`),
      source: "calendar",
      kind: "system",
      title: `Calendar not found: ${missing.join(", ")}`,
      detail: "The name in config.json doesn't match Google. Run `npm run doctor` to see the real list.",
      url: "https://calendar.google.com/calendar/r/settings",
      dueAt: null,
      category: "system",
      categoryLabel: "Setup",
      categoryWeight: 30,
      domain: "personal",
      unmissable: false,
      emphasised: false,
      tier: "system",
      reasons: ["configuration"],
      contentHash: contentHash({ missing }),
      meta: { available },
    });
  }

  return items;
}
