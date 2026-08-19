// sources/calendar.js
//
// Calendar events become items directly. No AI at all — an event already
// knows what it is, and asking a model to restate it was pure cost in v1.
//
// Two fixes carried over from the audit:
//   - day grouping is done in an explicit timezone, not the server's locale
//     (which on the Pi will not be Ottawa)
//   - calendar name matching normalises curly apostrophes, so "Sydney's
//     Demands" finally resolves

import { logger } from "../lib/log.js";
import { resolveCalendars, getEvents } from "../lib/google.js";
import { itemId, contentHash } from "../lib/ids.js";

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

function overlaps(a, b) {
  return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
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

  const events = await getEvents(matched, { timeMin, timeMax });
  log.info(`${events.length} events over ${horizonDays} days`);

  const todayKey = dayKey(now, tz);
  const alwaysImportant = (cfg.alwaysImportant || []).map((s) => s.toLowerCase());
  const items = [];

  for (const e of events) {
    const isToday = dayKey(e.start, tz) === todayKey;
    const important = alwaysImportant.includes(e.calendarName.toLowerCase());
    const needsPrep = Boolean(e.description?.trim()) || e.attendees > 0;

    // Base score: important calendars outrank ordinary ones, today outranks later.
    let priority = important ? 85 : 65;
    if (isToday) priority += 10;
    if (needsPrep) priority += 3;

    items.push({
      id: itemId("calendar", `${e.calendarId}:${e.id}`),
      source: "calendar",
      kind: isToday ? "today" : "upcoming",
      title: e.summary,
      // Today's row already shows the time in its left column, so repeating
      // it here is clutter. Future rows show a date there, so they keep it.
      detail: [
        e.calendarName,
        isToday || e.allDay ? null : timeLabel(e.start, tz),
        e.location || null,
      ].filter(Boolean).join(" · "),
      url: e.htmlLink,
      dueAt: e.start,
      priority,
      tier: important ? "important" : "school",
      reasons: [important ? `${e.calendarName} calendar` : "calendar"],
      contentHash: contentHash({ s: e.summary, st: e.start, en: e.end, l: e.location }),
      meta: {
        calendarName: e.calendarName,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        attendees: e.attendees,
        needsPrep,
      },
    });
  }

  // --- derived: same-day collisions, which no single event can tell you ---
  const timed = events.filter((e) => !e.allDay);
  const seenPair = new Set();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i], b = timed[j];
      if (dayKey(a.start, tz) !== dayKey(b.start, tz)) continue;
      if (!overlaps(a, b)) continue;
      const pair = [a.id, b.id].sort().join("|");
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);

      items.push({
        id: itemId("calendar", `conflict:${pair}`),
        source: "calendar",
        kind: "conflict",
        title: `Overlap: ${a.summary} and ${b.summary}`,
        detail: `${dayKey(a.start, tz)} · ${timeLabel(a.start, tz)} and ${timeLabel(b.start, tz)}`,
        url: a.htmlLink,
        dueAt: a.start,
        priority: 92,
        tier: "important",
        reasons: ["two events overlap"],
        contentHash: contentHash({ a: a.start, b: b.start, x: a.summary, y: b.summary }),
        meta: { conflict: true },
      });
    }
  }

  if (missing.length) {
    items.push({
      id: itemId("calendar", `missing:${missing.join(",")}`),
      source: "calendar",
      kind: "system",
      title: `Calendar not found: ${missing.join(", ")}`,
      detail: "Name in config.json doesn't match Google. Check spelling in the Calendar settings.",
      url: "https://calendar.google.com/calendar/r/settings",
      dueAt: null,
      priority: 55,
      tier: "system",
      reasons: ["configuration"],
      contentHash: contentHash({ missing }),
      meta: { available },
    });
  }

  return items;
}
