// brief/display.js
//
// The model for the small screen. Four pages, one question each:
//
//   1. TODAY     when is everything, and what is happening right now
//   2. TASKS     what do I owe someone, and by when
//   3. MONEY     what is the book worth and what moved it
//   4. YEAR      how far through the year, and what the book did each day
//
// Splitting into pages is what finally fixed the "too much going on" problem.
// One screen forced every domain to compete for the same square inches, so a
// heavy calendar week squeezed the portfolio into a corner. Four pages means
// each one can be laid out for its own content and breathe.
//
// The pages still assume a screen you mostly look at rather than operate:
// nothing here requires a click to become visible, and the deck rotates on its
// own. The cursor and the refresh button exist for the laptop, where you are
// debugging rather than glancing.
//
// Rule that survived from v1: SENTENCES OVER GRAPHICS. The day strip is the
// one graphic, because position answers "when" faster than text can.
//
// Pure function. No network, no store, no AI.

const DAY = 86400000;

/** Hour of day as a float (13.5 = 1:30pm) in a specific timezone. */
export function hourOfDay(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    })
      .formatToParts(new Date(date))
      .map((p) => [p.type, p.value])
  );
  const h = Number(parts.hour) % 24;
  return h + Number(parts.minute) / 60;
}

export function dayKey(date, timeZone) {
  // An all-day calendar event arrives from Google as a bare "YYYY-MM-DD" —
  // already the calendar day itself, not an instant in time (there's no
  // hour, no offset, nothing to place on a clock). Handing that straight to
  // `new Date(...)` parses it as UTC midnight, which — the moment this
  // timezone sits behind UTC, which Toronto always does — lands on the
  // PREVIOUS local day: "2026-08-27" becomes 2026-08-26, 8pm Toronto (EDT),
  // so an all-day event due today read as due yesterday and simply
  // vanished (nothing shows "yesterday" anywhere). The string already IS
  // the answer for a bare date; this only reinterprets it through a
  // timezone when there's an actual instant to reinterpret.
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(date));
}

function fmt(date, timeZone, opts) {
  // Same bare-date case dayKey() guards against, for the same reason: a
  // calendar-only "YYYY-MM-DD" (an all-day event's dueAt) has no instant to
  // place in `timeZone` — running it through one anyway is what read
  // "2026-08-27" back as Aug 26 the moment the zone sits behind UTC.
  // Formatted in UTC instead, the same Y-M-D comes back unchanged, since
  // there's no conversion left to do.
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...opts }).format(new Date(`${date}T00:00:00Z`));
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone, ...opts }).format(new Date(date));
}

export function clockLabel(date, timeZone) {
  return fmt(date, timeZone, { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);
}

/**
 * "Last updated" as a clock reading, not a countdown. This used to be a
 * one-off computed just for the Year page's `moneyUpdatedLabel`; it's the
 * shared shape every page's own "Last updated" line and the header both
 * use now, so the date only ever shows up once the pull is old enough to
 * have crossed midnight relative to `now` — otherwise `clockLabel` alone
 * would silently claim "this morning" for a stale Friday pull read on a
 * Monday.
 */
export function updatedLabel(at, timeZone, todayKey) {
  if (!at) return null;
  return dayKey(at, timeZone) === todayKey
    ? clockLabel(at, timeZone)
    : `${fmt(at, timeZone, { month: "short", day: "numeric" })}, ${clockLabel(at, timeZone)}`;
}

/** "40 min", "2h 10m", "3 days" — how far away, said the way a person would. */
export function distanceLabel(ms) {
  if (ms < 60000) return "now"; // check the raw value: 30s rounds UP to 1 min
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 10) return m ? `${h}h ${m}m` : `${h}h`;
  const days = Math.round(ms / DAY);
  return days === 1 ? "tomorrow" : `${days} days`;
}

export function durationLabel(start, end, allDay) {
  if (allDay) return "all day";
  if (!start || !end) return null;
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (mins <= 0 || mins > 60 * 24) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * A plain-English reason this matters, or nothing. Deliberately words rather
 * than coloured badges — on a glance screen a sentence fragment reads faster
 * than a legend you have to remember.
 */
export function priorityWord(item) {
  if (item.unmissable) return "can't miss";
  if (item.emphasised) return "you flagged it";
  if (item.meta?.needsReply) return "needs a reply";
  if (item.meta?.needsPrep) return "needs prep";
  if (item.meta?.recurring) return "routine";
  return null;
}

/**
 * A small pill for a single all-day event — everything a chip needs to
 * render, without the full item object exposed. Shared by the day strip's
 * own all-day row and the Week page's per-day badge, so the two surfaces
 * describe the same event the same way.
 */
function allDayChip(e) {
  return {
    id: e.id,
    title: e.title,
    swatch: e.swatch || (e.meta?.calendarName === "Personal" ? "gmail" : null) || e.domain || "personal",
    color: e.color || null,
    priority: priorityWord(e),
  };
}

/**
 * An all-day event carries no time to order by, so "logical" here means:
 * the ones that matter most lead — can't-miss first, then anything you
 * flagged — and everything else falls back to alphabetical, which is at
 * least predictable rather than arbitrary.
 */
function sortAllDay(list) {
  const rank = (e) => (e.unmissable ? 0 : e.emphasised ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || String(a.title).localeCompare(String(b.title)));
}

/**
 * Whether a calendar item still counts as "to come" as of `now`. A timed
 * item has an actual instant to compare against — unchanged, plain instant
 * comparison. An all-day item doesn't: its `dueAt` is a bare calendar date
 * (see dayKey() above), so comparing it against the current instant reads
 * it as "already past" for basically the entire day it's actually due on —
 * a bare "2026-08-27" parses to UTC midnight, which is already hours
 * behind "now" by the time anyone in Toronto is awake to look. An all-day
 * item stays "to come" for its whole calendar day instead, exactly the way
 * it already reads on screen ("all day", not a time that can pass).
 */
function isUpcoming(item, now, tz) {
  if (item.meta?.allDay) return dayKey(item.dueAt, tz) >= dayKey(now, tz);
  return new Date(item.dueAt) > now;
}

/**
 * How many calendar days away an all-day item's `dueAt` is, as a real day
 * count rather than a millisecond division — the same class of fix as
 * dayKey() above, for the same reason: a bare date has no instant for
 * subtraction to be meaningful against. Both sides are re-anchored to UTC
 * midnight of their OWN already-correct calendar day (see dayKey()), so the
 * division below is always an exact multiple of a day.
 */
function allDayDaysAway(dueAt, now, tz) {
  const from = new Date(`${dayKey(now, tz)}T00:00:00Z`).getTime();
  const to = new Date(`${dayKey(dueAt, tz)}T00:00:00Z`).getTime();
  return Math.round((to - from) / DAY);
}

/** Where a block sits in the day, in words. */
const CHUNKS = [
  { label: "Morning", from: 0, to: 12 },
  { label: "Afternoon", from: 12, to: 17 },
  { label: "Evening", from: 17, to: 22 },
  { label: "Night", from: 22, to: 24 },
];

export function chunkFor(hour) {
  return (CHUNKS.find((c) => hour >= c.from && hour < c.to) || CHUNKS[0]).label;
}

const CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** Where the year is up to — day number, total, and how far through. */
export function yearProgress(date, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(date))
      .map((x) => [x.type, Number(x.value)])
  );
  const leap = (p.year % 4 === 0 && p.year % 100 !== 0) || p.year % 400 === 0;
  const total = leap ? 366 : 365;
  const day = CUMULATIVE_DAYS[p.month - 1] + p.day + (leap && p.month > 2 ? 1 : 0);
  return { day, total, pct: Math.round((day / total) * 100), year: p.year };
}

// ==================================================================== year
//
// The day-of-year tracker, promoted from a footnote on Today to its own
// page: one cell per day, coloured by what your holdings actually did that
// day — a commit graph for a portfolio instead of for code.

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Seven buckets either side of flat. The split is a judgment call, not a
 * fact — these thresholds are sized for a personal book's ordinary daily
 * wobble (most days land within half a point of flat), not for a trading
 * desk. `dayPct` at exactly 0 is "flat", same as anything inside ±0.15 —
 * without a dead band nearly every day would show as a faint color for
 * noise the eye shouldn't be asked to read as a signal.
 */
export function colorBucket(dayPct) {
  if (dayPct == null || Number.isNaN(dayPct)) return "nodata";
  if (dayPct <= -2) return "r3";
  if (dayPct <= -0.75) return "r2";
  if (dayPct < -0.15) return "r1";
  if (dayPct <= 0.15) return "flat";
  if (dayPct < 0.75) return "g1";
  if (dayPct < 2) return "g2";
  return "g3";
}

/**
 * Weekday-aligned like a familiar commit graph: seven rows (Sun–Sat), one
 * column per week, colour carrying the day's ACTUAL portfolio move — the
 * weighted change in what your holdings were worth (money.js's `dayPct`),
 * never a raw total-to-total diff. A contribution or a withdrawal moves the
 * total without the market doing anything, and colouring that day as if it
 * were a market swing would be exactly the kind of manufactured signal this
 * whole rebuild has been about removing.
 *
 * Only a day money.js actually logged a `dayPct` for gets a colour. A day
 * before this tracking existed, or one the pipeline never ran on, is "no
 * data" rather than a guess built from the total-diff — the same rule as
 * everywhere else here: don't invent a number you don't have.
 */
export function yearGrid(history = [], now = new Date(), timeZone) {
  const todayKey = dayKey(now, timeZone);
  const year = Number(todayKey.slice(0, 4));
  const byDate = new Map(history.map((h) => [h.date, h]));

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));
  const totalDays = Math.round((dec31 - jan1) / DAY) + 1;
  const jan1Weekday = jan1.getUTCDay(); // 0 = Sunday

  const cells = [];
  const months = [];
  let seenMonth = -1;
  let weeks = 0;

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(jan1.getTime() + i * DAY);
    const date = d.toISOString().slice(0, 10);
    const weekday = d.getUTCDay();
    const week = Math.floor((i + jan1Weekday) / 7);
    weeks = Math.max(weeks, week + 1);
    const future = date > todayKey;
    const rec = future ? null : byDate.get(date);
    const dayPct = rec && typeof rec.dayPct === "number" ? Number(rec.dayPct.toFixed(2)) : null;
    // Same "don't invent a number you don't have" rule as dayPct: a day
    // money.js logged before dayValue existed carries dayPct alone, so this
    // stays null there rather than getting derived from the total (which,
    // same as dayPct, would be wrong on a deposit/withdrawal day).
    const dayValue = rec && typeof rec.dayValue === "number" ? Math.round(rec.dayValue) : null;

    cells.push({
      date, week, weekday,
      today: date === todayKey,
      future,
      dayPct,
      dayValue,
      bucket: future ? "future" : colorBucket(dayPct),
    });

    const m = Number(date.slice(5, 7));
    if (m !== seenMonth) { months.push({ label: MONTH_LABELS[m - 1], week }); seenMonth = m; }
  }

  return { weeks, cells, months };
}

/** Strip the noise the detail line already carries elsewhere. */
function locationOf(item) {
  const loc = item.meta?.location || null;
  if (loc) return String(loc).split(",")[0].trim().slice(0, 34);
  // fall back to the tail of the detail line, which calendar.js builds as
  // "note · duration · location"
  const bits = String(item.detail || "").split(" · ").map((s) => s.trim());
  const last = bits[bits.length - 1];
  if (last && !/^\d/.test(last) && !/^(all day|\d+\s?(min|h))/i.test(last) && bits.length > 1) return last;
  return null;
}

function prepOf(item) {
  const bits = String(item.detail || "").split(" · ").map((s) => s.trim());
  const first = bits[0];
  // The first segment is a human note only if it isn't a duration or a time.
  if (!first) return null;
  if (/^(all day|\d+\s?min|\d+h)/i.test(first)) return null;
  if (/^\d{1,2}:\d{2}/.test(first)) return null;
  if (bits.length < 2) return null;
  return first;
}

/**
 * How long since each source was actually FETCHED — not since the page was
 * redrawn. Without this the footer reads "updated 6:11 PM" forever, because
 * the model recomputes every minute from the local store whether or not
 * anything has been pulled from Google since yesterday. On a screen you can't
 * click, a freshness indicator that always says "fresh" is worse than none.
 */
export function freshness(sources = {}, { now = new Date(), staleAfterHours = 8, errors = {} } = {}) {
  const ages = {};
  let oldest = null;
  for (const [name, at] of Object.entries(sources)) {
    if (!at) { ages[name] = null; continue; }
    const mins = Math.round((now - new Date(at)) / 60000);
    ages[name] = mins;
    // money and notes run once a day by design; the live pair is what matters
    if (name === "email" || name === "calendar") {
      oldest = oldest === null ? mins : Math.max(oldest, mins);
    }
  }
  const label =
    oldest === null ? "never checked"
      : oldest < 2 ? "just checked"
      : oldest < 60 ? `checked ${oldest} min ago`
      : `checked ${Math.round(oldest / 60)}h ago`;
  // A broken credential is invisible on a screen you can't click, so say it.
  const broken = Object.entries(errors)
    .filter(([, e]) => e && e.message)
    .map(([name]) => name);

  return {
    ages,
    oldestMinutes: oldest,
    label,
    broken,
    problem: broken.length ? `${broken.join(" and ")} failing — run npm run doctor` : null,
    stale: oldest === null || oldest > staleAfterHours * 60,
  };
}

// ================================================================= tasks
//
// A task is something you owe, as opposed to somewhere you have to be. The
// distinction matters because they fail differently: you miss an event by not
// turning up, and you miss a task by not noticing it existed.
//
// Three origins, and the page says which is which — partly so you can trust
// it, partly so a silent Brightspace is visible as an absence rather than
// looking like a genuinely empty week. The vault stopped being one of these:
// it's life context you keep, not something the secretary tries to parse
// into obligations.

const TASK_CATEGORIES = new Set(["assessment", "deadline", "assignment", "opportunity", "admin"]);

/** Does this belong on the tasks page rather than the timeline? */
export function isTaskLike(item) {
  if (item.source === "brightspace") return true;
  if (item.source === "email") return Boolean(item.meta?.needsReply) || item.tier === "opportunity";
  if (item.source === "calendar") {
    // All-day calendar entries are how most people write down a due date.
    if (item.meta?.allDay) return true;
    if (TASK_CATEGORIES.has(item.category)) return true;
    if (/\b(due|submit|deadline|hand in|apply by|register by)\b/i.test(item.title || "")) return true;
  }
  return false;
}

const ORIGIN_LABELS = {
  calendar: "Calendar",
  brightspace: "Brightspace",
  email: "Email",
  money: "Finance",
};

/**
 * A week-ahead capacity check, not a scheduler. For each of the next `days`
 * days, how many of the assumed waking hours (`wakeStart`–`wakeEnd`, same
 * 7am/11pm default the day strip already uses) the calendar has already
 * claimed, and how many are still open — busy time from overlapping events
 * is only counted once, not double-booked into more than 16 hours of "busy".
 *
 * Deliberately does NOT try to match a looming item to a specific free
 * block, because nothing in the data says how long any given task or
 * deadline would actually take — guessing that would be exactly the kind
 * of fabricated number this project has avoided everywhere else (see
 * `yearGrid()`'s dayPct/dayValue). Instead the two lists — how much room
 * each day has, and what's coming due in that same window — are handed
 * back side by side so a human can weigh them against each other.
 *
 * Pure function: `events` is the already-filtered, already-sorted calendar
 * list `buildDisplay()` builds as `events`; `tasks` is `live` filtered to
 * `isTaskLike()` items, same set the Tasks page itself uses.
 */
export function weekForecast(events, tasks, { now, tz, days = 7, wakeStart = 7, wakeEnd = 23 } = {}) {
  const wakeHours = wakeEnd - wakeStart;
  const forecast = [];

  for (let n = 0; n < days; n++) {
    const d = new Date(now.getTime() + n * DAY);
    const key = dayKey(d, tz);
    const dayEvents = events.filter(
      (e) => !e.meta?.allDay && e.meta?.end && dayKey(e.dueAt, tz) === key
    );

    // All-day events for this specific day — kept separate from dayEvents
    // above on purpose. They still don't touch the busy/free math (an
    // all-day event has no real duration to subtract, and guessing one
    // would be exactly the kind of fabricated number this function already
    // avoids for the looming list), but a day that reads "100% free" while
    // quietly carrying a deadline was the actual gap: this is what a small
    // per-day badge renders from, so that day at least SAYS it isn't empty.
    const dayAllDay = sortAllDay(
      events.filter((e) => e.meta?.allDay && dayKey(e.dueAt, tz) === key)
    ).map(allDayChip);

    // Clip each event to the waking window — kept as its own {start, end,
    // swatch} below both to merge overlaps before summing busy hours (two
    // meetings double-booked over the same hour is still one busy hour, not
    // two) and, unmerged, to draw each event's own coloured segment on the
    // day's bar — same swatch the day strip itself colours blocks by,
    // stacked in calendar order rather than merged, so two overlapping
    // events still both show their own colour the way the day strip does.
    const clipped = dayEvents
      .map((e) => {
        const start = Math.max(wakeStart, hourOfDay(e.dueAt, tz));
        // An event whose end lands on a different calendar day (crosses
        // midnight) has nothing meaningful to clip to on THIS day beyond
        // the window's own close.
        const sameDayEnd = dayKey(e.meta.end, tz) === key;
        const rawEnd = sameDayEnd ? hourOfDay(e.meta.end, tz) : wakeEnd;
        const end = Math.min(wakeEnd, Math.max(start, rawEnd));
        const swatch = e.swatch || (e.meta?.calendarName === "Personal" ? "gmail" : null) || e.domain || "personal";
        return { start, end, swatch, color: e.color || null };
      })
      .filter((c) => c.end > c.start)
      .sort((a, b) => a.start - b.start);

    let busyHours = 0;
    let mergedEnd = -Infinity;
    for (const { start: s, end: e } of clipped) {
      const start = Math.max(s, mergedEnd);
      if (e > start) busyHours += e - start;
      mergedEnd = Math.max(mergedEnd, e);
    }
    busyHours = Math.round(busyHours * 10) / 10;
    const freeHours = Math.round((wakeHours - busyHours) * 10) / 10;

    // Purely visual — no label, no metadata, just roughly-sized-and-coloured
    // fills so the bar itself gives a sense of the day's density and shape.
    // Left untouched (grey, the bar's own background) wherever nothing was
    // clipped in above: that's what actually reads as "free" here.
    const pct = (h) => (wakeHours ? ((h - wakeStart) / wakeHours) * 100 : 0);
    const segments = clipped.map((c) => ({
      left: pct(c.start),
      width: Math.max(0.6, pct(c.end) - pct(c.start)),
      swatch: c.swatch,
      color: c.color,
    }));

    forecast.push({
      key,
      label: n === 0 ? "Today" : n === 1 ? "Tomorrow" : fmt(d, tz, { weekday: "long" }),
      dateLabel: fmt(d, tz, { month: "short", day: "numeric" }),
      busyHours,
      freeHours,
      load: wakeHours ? Math.round((busyHours / wakeHours) * 100) : 0,
      eventCount: dayEvents.length,
      segments,
      allDay: dayAllDay,
    });
  }

  const windowEnd = now.getTime() + days * DAY;
  const looming = tasks
    .filter((i) => i.dueAt && isUpcoming(i, now, tz) && new Date(i.dueAt).getTime() <= windowEnd)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .map((i) => {
      const dLeft = i.meta?.allDay ? allDayDaysAway(i.dueAt, now, tz) : Math.round((new Date(i.dueAt) - now) / DAY);
      return {
        id: i.id,
        title: i.title,
        in: dLeft <= 0 ? "today" : dLeft === 1 ? "tomorrow" : `${dLeft} days`,
        dateLabel: fmt(i.dueAt, tz, { weekday: "short", month: "short", day: "numeric" }),
        note: priorityWord(i),
      };
    });

  return { wakeHours, days: forecast, looming };
}

/**
 * Buckets, not a flat sorted list. "In 9 days" and "in 40 days" are the same
 * thought — later — and reading two numbers to work that out is exactly the
 * friction this page exists to remove.
 */
export function buildTasks(live, { now, tz, config = {}, priorities = [] }) {
  const cfg = config.display || {};
  const picks = new Map(priorities.map((p) => [p.id, p]));
  const rows = [];

  for (const item of live) {
    if (!isTaskLike(item)) continue;
    if (item.kind === "system") continue;

    {
      const dueAt = item.dueAt || null;
      const daysOut = dueAt
        ? (item.meta?.allDay ? allDayDaysAway(dueAt, now, tz) : Math.floor((new Date(dueAt) - now) / DAY))
        : null;
      const pick = picks.get(item.id) || null;
      rows.push({
        id: item.id,
        title: item.title,
        // The model's next-physical-action line, when it chose this one.
        // This is the difference between a list you read and a list you act on.
        do: pick?.do || null,
        why: pick?.why || null,
        top: Boolean(pick),
        origin: item.source,
        originLabel: ORIGIN_LABELS[item.source] || item.source,
        domain: item.domain || "personal",
        context: item.meta?.note || item.categoryLabel || null,
        age: item.meta?.age ?? null,
        dueAt,
        daysOut,
        due: dueAt
          ? daysOut < 0 ? "overdue"
            : daysOut === 0 ? (item.meta?.allDay ? "today" : clockLabel(dueAt, tz))
            : daysOut === 1 ? "tomorrow"
            : `${daysOut} days`
          : null,
        dateLabel: dueAt ? fmt(dueAt, tz, { weekday: "short", month: "short", day: "numeric" }) : null,
        priority: priorityWord(item),
        weight: item.categoryWeight ?? 0,
        unmissable: Boolean(item.unmissable || item.emphasised),
      });
    }
  }

  // Dated first and soonest-first inside that; undated ordered by how much the
  // rules already decided they matter.
  const cmp = (a, b) => {
    if (a.top !== b.top) return b.top - a.top;   // what the model flagged, first
    if (a.dueAt && b.dueAt) return new Date(a.dueAt) - new Date(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return b.weight - a.weight;
  };

  const bucket = (r) => {
    if (r.daysOut === null) return "someday";
    if (r.daysOut < 0) return "overdue";
    if (r.daysOut === 0) return "today";
    if (r.daysOut <= 7) return "week";
    return "later";
  };

  const defs = [
    { key: "overdue", label: "Overdue", urgent: true },
    { key: "today", label: "Due today", urgent: true },
    { key: "week", label: "This week", urgent: false },
    { key: "later", label: "Further out", urgent: false },
    { key: "someday", label: "No date on it", urgent: false },
  ];

  const groups = defs
    .map((d) => ({ ...d, items: rows.filter((r) => bucket(r) === d.key).sort(cmp) }))
    .filter((g) => g.items.length);

  // A cap per group rather than overall, so a pile of undated, low-priority
  // items can't bury the two things actually due this week.
  const perGroup = cfg.maxTasksPerGroup ?? 8;
  for (const g of groups) {
    g.hidden = Math.max(0, g.items.length - perGroup);
    g.items = g.items.slice(0, perGroup);
  }

  const counts = Object.fromEntries(
    Object.keys(ORIGIN_LABELS).map((k) => [k, rows.filter((r) => r.origin === k).length])
  );

  return { groups, total: rows.length, counts, urgent: rows.filter((r) => r.daysOut !== null && r.daysOut <= 0).length };
}

export function buildDisplay({ items = [], money = null, priorities = [], sources = {}, errors = {}, history = [], config = {}, now = new Date() } = {}) {
  const tz = config.timezone || "America/Toronto";
  const cfg = config.display || {};
  const dayCount = cfg.days ?? 3;
  const maxDeadlines = cfg.maxDeadlines ?? 8;

  const live = items.filter((i) => {
    if (i.status === "done" || i.status === "dismissed") return false;
    if (i.status === "snoozed" && i.snoozeUntil && new Date(i.snoozeUntil) > now) return false;
    return true;
  });

  const todayKey = dayKey(now, tz);

  // Computed once, early, so the portfolio/Year pages and the Today/Tasks
  // pages and the header can all share these rather than each re-deriving
  // their own version. Money's is money.js's own last pull; the general one
  // tracks the OLDER of email/calendar — the same "live pair" freshness()
  // already uses to decide staleness — so it never claims to be more
  // current than the slower of the two sources actually feeding those pages.
  const moneyUpdatedLabel = updatedLabel(sources.money, tz, todayKey);
  const livePairAt = ["email", "calendar"]
    .map((k) => sources[k])
    .filter(Boolean)
    .map((iso) => new Date(iso).getTime());
  const lastUpdatedLabel = livePairAt.length
    ? updatedLabel(new Date(Math.min(...livePairAt)), tz, todayKey)
    : null;

  const events = live
    .filter((i) => i.source === "calendar" && i.dueAt && i.kind !== "system")
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  const todays = events.filter((e) => dayKey(e.dueAt, tz) === todayKey);

  // ---------------------------------------------------------------- strip
  // A day-shaped window: 7am to 11pm covers an ordinary day without wasting
  // space on hours nothing ever happens in, but it still opens wider for
  // whatever's actually on the calendar — a 5am flight pulls the start
  // earlier, an event past 11pm pushes the end later — rather than clipping
  // it or leaving the strip's scale the same regardless of the day's shape.
  // An event before the 4am floor still shows, just pinned to the left edge
  // rather than positioned at its exact time.
  let startHour = 7;
  let endHour = 23;
  for (const e of todays) {
    if (e.meta?.allDay) continue;
    startHour = Math.min(startHour, Math.floor(hourOfDay(e.dueAt, tz)));
    if (e.meta?.end) endHour = Math.max(endHour, Math.ceil(hourOfDay(e.meta.end, tz)) || 24);
  }
  startHour = Math.max(4, startHour);
  endHour = Math.min(24, Math.max(endHour, startHour + 8));
  const span = endHour - startHour;
  const pct = (h) => Math.max(0, Math.min(100, ((h - startHour) / span) * 100));

  // Start/end hours computed first, in their own pass, so overlap can be
  // checked against every OTHER event on the day — the block below still
  // needs its own s/en for width and the past/upcoming/collision math.
  const timedToday = todays
    .filter((e) => !e.meta?.allDay)
    .map((e) => {
      const s = hourOfDay(e.dueAt, tz);
      // An event with a start but no end still happened at a time, and leaving
      // it off the strip made the bar look emptier than the day was. Assume an
      // hour rather than drawing nothing.
      const rawEnd = e.meta?.end ? hourOfDay(e.meta.end, tz) : s + 1;
      const en = Math.max(s + 0.25, rawEnd || s + 1);
      return { e, s, en };
    });

  const blocks = timedToday.map(({ e, s, en }, i) => {
    const width = Math.max(1.2, pct(en) - pct(s));
    return {
      id: e.id,
      left: pct(s),
      width,
      // Colour carries the swatch here — it's the one place on this screen
      // where a hue does work text can't. Swatch mirrors the real Apple
      // Calendar colours (CANNOT MISS is orange there, so it's orange
      // here too) rather than the coarser life-lane domain; see
      // calendarSwatch() in lib/classify.js for the one deliberate
      // override, the default email-named calendar.
      //
      // Two fallbacks, for items stored before this field existed (or
      // collected by a server still running the old code). meta.calendarName
      // gets rewritten to the literal string "Personal" at collection time
      // ONLY for the default, email-named calendar (see sources/calendar.js)
      // — the same signal calendarSwatch() itself keys on, recovered from
      // what's already stored — so that's checked before falling all the
      // way back to domain, which is the wrong lane for that calendar
      // specifically (it's how an un-migrated Physio event ended up
      // reading as plain "personal", the same colour as Gym Schedule,
      // instead of the link-blue override).
      swatch: e.swatch || (e.meta?.calendarName === "Personal" ? "gmail" : null) || e.domain || "personal",
      // The calendar's real Google colour, when the item was collected with
      // one on record. The frontend paints this straight over the swatch
      // above when present — swatch stays only as the fallback.
      color: e.color || null,
      // True when this event's time range genuinely intersects another
      // event's on the same day. Purely a render-time flag computed fresh
      // from real start/end hours every time — nothing stored, no synthetic
      // item, no separate id. Drives a small corner marker on the block;
      // never changes its colour, which stays the calendar's own.
      overlap: timedToday.some((o, j) => j !== i && s < o.en && en > o.s),
      // Below ~6% a label is a clipped fragment; colour still identifies it,
      // and the rows underneath name it.
      label: width >= 6 ? String(e.title).slice(0, 30) : "",
      time: e.meta?.end && width >= 24 && String(e.title).length < 22
        ? `${clockLabel(e.dueAt, tz)}–${clockLabel(e.meta.end, tz)}`
        : "",
      // What's behind you should read as done, not as pending.
      past: new Date(e.meta?.end || new Date(e.dueAt).getTime() + 3600000) < now,
      important: Boolean(e.unmissable || e.emphasised),
      // Everything the block is too narrow to say. There's a pointer on this
      // thing again, so a 20-minute sliver can still identify itself without
      // stealing width from the events that do fit their label.
      detail: {
        title: e.title,
        range: e.meta?.end
          ? `${clockLabel(e.dueAt, tz)} – ${clockLabel(e.meta.end, tz)}`
          : clockLabel(e.dueAt, tz),
        duration: durationLabel(e.dueAt, e.meta?.end, false),
        where: locationOf(e),
        prep: prepOf(e),
        priority: priorityWord(e),
        domain: e.domain || "personal",
      },
    };
  });

  // A full day has no hour to plot a block at, so an all-day event never
  // becomes one (see timedToday's own filter above) — it sits in its own
  // row above the strip instead. Same real colour as a timed block when
  // one's on record (allDayChip mirrors blocks' own swatch/colour fallback
  // exactly); can't-miss first, then alphabetical — see sortAllDay().
  const allDayToday = sortAllDay(todays.filter((e) => e.meta?.allDay)).map(allDayChip);

  const nowHour = hourOfDay(now, tz);

  // Hour ticks under the blocks. The chunk names say roughly when; these let
  // you read exactly when without a clock column, which was the whole
  // complaint about the old badge layout.
  const ticks = [];
  for (let h = Math.ceil(startHour); h <= endHour; h++) {
    const major = h % 3 === 0;
    ticks.push({
      hour: h,
      left: pct(h),
      major,
      label: major && h < endHour ? (h === 12 ? "12" : h > 12 ? `${h - 12}` : `${h}`) : "",
    });
  }

  const chunks = CHUNKS.filter((c) => c.to > startHour && c.from < endHour).map((c) => ({
    label: c.label,
    left: pct(Math.max(c.from, startHour)),
    width: pct(Math.min(c.to, endHour)) - pct(Math.max(c.from, startHour)),
  }));

  // ------------------------------------------------------------------ now
  const running = todays.find(
    (e) => !e.meta?.allDay && e.meta?.end && new Date(e.dueAt) <= now && new Date(e.meta.end) > now
  );
  const upcoming = todays.filter((e) => isUpcoming(e, now, tz));
  // All-day items have no real clock time, so they can't drive the hero's
  // "next"/"soon" math — skip past them for that, while still keeping them
  // in `upcoming`/`today` below (that's what surfaces them in "rest of
  // today").
  const next = upcoming.find((e) => !e.meta?.allDay) || null;

  let hero;
  if (running) {
    hero = {
      kind: "running",
      lead: `${running.title} until ${clockLabel(running.meta.end, tz)}`,
      sub: [locationOf(running), chunkFor(nowHour)].filter(Boolean).join(" · "),
      urgent: true,
    };
  } else if (next && new Date(next.dueAt) - now <= 2 * 3600000) {
    hero = {
      kind: "soon",
      lead: `${next.title} in ${distanceLabel(new Date(next.dueAt) - now)}`,
      sub: [
        locationOf(next),
        next.meta?.end ? `${clockLabel(next.dueAt, tz)}–${clockLabel(next.meta.end, tz)}` : clockLabel(next.dueAt, tz),
      ].filter(Boolean).join(" · "),
      urgent: true,
    };
  } else if (next) {
    hero = {
      kind: "later",
      lead: `Nothing until ${next.title}, ${clockLabel(next.dueAt, tz)}`,
      sub: `${distanceLabel(new Date(next.dueAt) - now)} clear`,
      urgent: false,
    };
  } else {
    hero = { kind: "clear", lead: "Nothing else scheduled today", sub: "", urgent: false };
  }

  // ---------------------------------------------------------------- today
  const today = upcoming.map((e) => ({
    id: e.id,
    time: e.meta?.allDay ? "all day" : clockLabel(e.dueAt, tz),
    title: e.title,
    where: locationOf(e),
    // The time column already reads "all day"; repeating it as a duration
    // produced "all day · all day".
    duration: e.meta?.allDay ? null : durationLabel(e.dueAt, e.meta?.end, false),
    prep: prepOf(e),
    priority: priorityWord(e),
  }));

  // ----------------------------------------------------------------- days
  const days = [];
  for (let n = 1; n <= dayCount; n++) {
    const d = new Date(now.getTime() + n * DAY);
    const key = dayKey(d, tz);
    const dayEvents = events
      .filter((e) => dayKey(e.dueAt, tz) === key)
      .map((e) => ({
        id: e.id,
        time: e.meta?.allDay ? "all day" : clockLabel(e.dueAt, tz),
        chunk: e.meta?.allDay ? null : chunkFor(hourOfDay(e.dueAt, tz)),
        title: e.title,
        where: locationOf(e),
        duration: e.meta?.allDay ? null : durationLabel(e.dueAt, e.meta?.end, false),
        priority: priorityWord(e),
      }));
    days.push({
      key,
      label: n === 1 ? "Tomorrow" : fmt(d, tz, { weekday: "long" }),
      dateLabel: fmt(d, tz, { month: "short", day: "numeric" }),
      items: dayEvents,
      clear: dayEvents.length === 0,
    });
  }

  // ------------------------------------------------------------ deadlines
  const shownIds = new Set([...todays.map((e) => e.id), ...days.flatMap((d) => d.items.map((i) => i.id))]);
  const deadlines = live
    .filter((i) => i.dueAt && !shownIds.has(i.id) && isUpcoming(i, now, tz) && i.kind !== "system")
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .slice(0, maxDeadlines)
    .map((i) => {
      const dLeft = i.meta?.allDay ? allDayDaysAway(i.dueAt, now, tz) : Math.round((new Date(i.dueAt) - now) / DAY);
      return {
        id: i.id,
        in: dLeft <= 0 ? "today" : dLeft === 1 ? "tomorrow" : `${dLeft} days`,
        dateLabel: fmt(i.dueAt, tz, { month: "short", day: "numeric" }),
        title: i.title,
        note: priorityWord(i),
        near: dLeft <= 3,
      };
    });

  // ------------------------------------------------------------ portfolio
  // Everything arriving here is already in one currency: money.js converts at
  // the live rate before it sums anything. The old version added USD prices to
  // CAD prices as if they were the same unit, which made the total, every
  // weight, and therefore "biggest position" all wrong.
  const short = (t) => String(t).replace(/\.(TO|V|NE|CN)$/i, "");
  const r = (n, d = 1) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));

  let portfolio = null;
  if (money) {
    const all = (money.positions || []).filter((p) => p.value != null);
    const priced = all.filter((p) => p.dayChangePct != null && !p.stale);
    const sorted = [...priced].sort((a, b) => b.dayChangePct - a.dayChangePct);
    const take = cfg.movers ?? 6;

    const mover = (p) => ({
      ticker: short(p.ticker),
      pct: r(p.dayChangePct, 2),
      // What the move was worth. 0.4% of your biggest holding beats 6% of the
      // smallest, and the percentage alone hides that completely.
      value: r(p.dayChangeValue, 0),
      weightPct: r(p.weightPct, 1),
    });

    portfolio = {
      base: money.base || "CAD",
      // Same timestamp basis as the Year page's own "Last updated" — see
      // moneyUpdatedLabel above — so the two never disagree about when the
      // book was last actually priced.
      updatedLabel: moneyUpdatedLabel,
      total: money.total,
      dayPct: r(money.dayPct, 2),
      dayValue: r(money.dayChangeValue, 0),
      weekPct: r(money.weekPct, 1),
      monthPct: r(money.monthPct, 1),
      holdingCount: money.holdingCount ?? all.length,
      historyDays: money.historyDays ?? 0,
      marketStatus: money.marketStatus || null,
      at: money.at || null,
      holdingsFrom: money.holdingsFrom || null,
      fx: money.fx || {},
      // Named, not counted. A price that failed to refresh is the one thing on
      // this page you must not trust, so it says which ones.
      staleTickers: (money.stale || []).map(short),
      missingTickers: (money.unavailable || []).map(short),

      up: sorted.filter((p) => p.dayChangePct > 0).slice(0, take).map(mover),
      down: sorted.filter((p) => p.dayChangePct < 0).slice(-take).reverse().map(mover),

      // The whole book, biggest first. It follows the vault — buy something,
      // write the note, and it shows up here without a code or config change.
      positions: [...all].sort((x, y) => (y.value ?? -1) - (x.value ?? -1)).map((p) => ({
        ticker: p.ticker,
        display: short(p.ticker),
        name: p.name,
        shares: p.shares,
        price: r(p.price, 2),
        currency: p.currency,
        value: r(p.value, 0),
        weightPct: r(p.weightPct, 1),
        dayChangePct: r(p.dayChangePct, 2),
        dayChangeValue: r(p.dayChangeValue, 0),
        totalReturnPct: r(p.totalReturnPct, 1),
        stale: Boolean(p.stale),
      })),

      // A ticker related to what's already held, that might help fill a
      // thin sector — see lib/stockIdeas.js. Real Yahoo similarity data
      // and real sector weights, never an AI pitch; empty when nothing
      // has been computed yet or the last refresh came up dry.
      stockIdea: (money.stockIdea || []).map((c) => ({
        ticker: short(c.symbol),
        name: c.name || null,
        price: r(c.price, 2),
        currency: c.currency || null,
        sector: c.sectorBucket || c.sector || null,
        summary: c.summary || null,
        reason: c.reason || null,
      })),
      stockIdeaAt: money.stockIdeaAt || null,
    };
  }

  // Rule hits the money source raised — a 6% move, a drifted weight, a
  // contribution date. These are the sentences; the numbers above are context.
  const alerts = live
    .filter((i) => i.source === "money" && i.kind !== "system")
    .sort((a, b) => (b.categoryWeight ?? 0) - (a.categoryWeight ?? 0))
    .slice(0, cfg.maxMoneyAlerts ?? 5)
    .map((i) => ({ id: i.id, title: i.title, detail: i.detail || null, kind: i.kind }));

  const tasks = buildTasks(live, { now, tz, config, priorities });

  // ------------------------------------------------------------- week
  // New, first cut, per Jon: a busy-vs-free forecast plus the looming list
  // it's meant to be read against — see weekForecast()'s own comment for
  // why the two aren't matched to each other automatically. Its own page
  // for now, to try out before folding into Today (if it earns a spot).
  const week = weekForecast(events, live.filter(isTaskLike), {
    now, tz, days: cfg.forecastDays ?? 7,
  });

  // moneyUpdatedLabel itself is computed early, above, alongside
  // lastUpdatedLabel — this is just where the Year page's copy of it lives.
  const year = {
    ...yearProgress(now, tz), ...yearGrid(history, now, tz), moneyUpdatedLabel,
    base: money?.base || "CAD", // so the hover tooltip can label the dollar figure correctly
  };

  return {
    // Bumped from v1: the frontend now expects pages. A stale bundle asking
    // for v1 gets told to rebuild instead of rendering half a screen.
    schema: "display-v2",
    generatedAt: now.toISOString(),
    timezone: tz,
    dateLabel: fmt(now, tz, { weekday: "long", month: "long", day: "numeric" }),
    clock: clockLabel(now, tz),
    // The header's own "Last updated" and Today/Tasks pages' — see
    // updatedLabel() and the live-pair computation above.
    lastUpdatedLabel,
    freshness: freshness(sources, { now, staleAfterHours: cfg.staleAfterHours ?? 8, errors }),

    // The deck. `badge` is the one number worth seeing from the page dots.
    // Money and Year don't get one: the Money badge used to be the count of
    // "Decisions" alerts, but that section is gone from the page itself now
    // (see brief/display.js's alerts history) — a number in the tab with
    // nothing on the page to explain it is exactly the "what's this
    // referencing" clutter it was supposed to avoid. Year's badge was just
    // the same year-progress percent already shown big on that page's own
    // header, so it wasn't telling you anything new either.
    pages: [
      { id: "today", label: "Today", badge: today.length || null },
      { id: "week", label: "Week", badge: null },
      { id: "tasks", label: "Tasks", badge: tasks.urgent || null },
      { id: "money", label: "Finances", badge: null },
      { id: "year", label: "Year", badge: null },
    ],

    // ---- page 1: Today
    hero,
    strip: { startHour, endHour, nowPct: pct(nowHour), blocks, chunks, ticks, allDay: allDayToday },
    today,
    days,

    // ---- page 2: Week (new, testing)
    week,

    // ---- page 3: Tasks
    tasks,
    deadlines,

    // ---- page 4: Finances
    portfolio,
    alerts,
    priorities,

    // ---- page 5: Year
    year,
  };
}
