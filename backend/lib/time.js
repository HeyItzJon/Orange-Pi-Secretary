// lib/time.js
//
// "Midnight" as one shared idea instead of a slightly different guess in
// every file that needs it. A few caches in this app are conceptually
// daily — refresh once a day, not once every N hours — and a rolling
// N-hour TTL doesn't actually mean that: a holdings sync at 11:58 PM and
// a check at 12:02 AM are four minutes apart by the clock, but they're
// two different days by the calendar. A daily cache should treat that as
// a new day regardless of how few real hours passed, the same way "today"
// on the display resets at midnight rather than 24 hours after you last
// looked at it. This is the one place that logic lives, so every
// daily-cadence cache — holdings, the stock idea, and whatever else turns
// out to want it — agrees on what a "new day" means.

/** The calendar date (YYYY-MM-DD) `date` falls on in `tz` — the same
 *  format every other date-keyed table in this app already uses
 *  (sources/calendar.js's dayKey, brief/display.js's dayKey,
 *  sources/money.js's portfolio_days stamp). */
export function localDateKey(date, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/**
 * How many calendar days (in `tz`) separate two timestamps — 0 if they
 * fall on the same local day, 1 if `to` is the very next local day even
 * if only minutes separate them, and so on. Pure: takes both timestamps
 * explicitly rather than reaching for the system clock, so it's fully
 * testable with fixed inputs instead of needing to mock "now."
 */
export function calendarDaysBetween(fromISO, toISO, tz) {
  const from = new Date(localDateKey(new Date(fromISO), tz) + "T00:00:00Z").getTime();
  const to = new Date(localDateKey(new Date(toISO), tz) + "T00:00:00Z").getTime();
  return Math.round((to - from) / 86400000);
}
