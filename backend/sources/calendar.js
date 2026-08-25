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

  const events = await getEvents(matched, { timeMin, timeMax });
  log.info(`${events.length} events over ${horizonDays} days`);

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
      unmissable: Boolean(category.unmissable),
      emphasised,
      tier: category.id,
      reasons: [category.why, emphasised ? "written in caps" : null].filter(Boolean),
      contentHash: contentHash({ s: e.summary, st: e.start, en: e.end, l: e.location, d: note }),
      meta: {
        calendarName: isEmailLike(e.calendarName) ? "Personal" : e.calendarName,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        attendees: e.attendees,
        recurring: Boolean(e.recurringEventId),
        needsPrep: Boolean(note) || e.attendees > 1,
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
        title: `${a.summary} overlaps ${b.summary}`,
        detail: `${timeLabel(a.start, tz)} and ${timeLabel(b.start, tz)} · same day`,
        url: a.htmlLink,
        dueAt: a.start,
        category: "conflict",
        categoryLabel: "Clash",
        categoryWeight: 46,
        domain: deriveDomain({ title: `${a.summary} ${b.summary}`, category: null }, config),
        swatch: "conflict",
        unmissable: true,
        emphasised: false,
        tier: "conflict",
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
