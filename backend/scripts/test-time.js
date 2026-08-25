// scripts/test-time.js — the calendar-day math behind every "refresh once
// a day" cache (holdings, the stock idea). The whole point of this module
// is that it's NOT the same thing as a rolling 24-hour TTL, so the tests
// below specifically prove the case where those two definitions disagree:
// a gap of only minutes that crosses local midnight.
//
// Run: node scripts/test-time.js

import assert from "node:assert/strict";
import { localDateKey, calendarDaysBetween } from "../lib/time.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const TZ = "America/Toronto";

group("localDateKey — the calendar date a timestamp falls on, in a given timezone");

test("returns YYYY-MM-DD in the target timezone", () => {
  // Noon UTC in August is early morning in Toronto (EDT, UTC-4) — same
  // calendar date either way, just proving the format and the tz param
  // are both actually being used.
  assert.equal(localDateKey(new Date("2026-08-21T12:00:00Z"), TZ), "2026-08-21");
});

test("a timestamp just after UTC midnight can still be the PREVIOUS day in an earlier timezone", () => {
  // 2026-08-22T02:00:00Z is 2026-08-21 10:00 PM in Toronto (UTC-4).
  assert.equal(localDateKey(new Date("2026-08-22T02:00:00Z"), TZ), "2026-08-21");
});

group("calendarDaysBetween — this is the whole point: midnight, not a rolling 24h window");

test("same local calendar day, hours apart, is 0 — not stale", () => {
  const morning = "2026-08-21T13:00:00Z";  // 9 AM Toronto
  const evening = "2026-08-22T00:30:00Z";  // 8:30 PM Toronto, same day
  assert.equal(calendarDaysBetween(morning, evening, TZ), 0);
});

test("four minutes apart but crossing local midnight is 1 — the key behavior a rolling TTL gets wrong", () => {
  const before = "2026-08-22T03:58:00Z";  // 11:58 PM Toronto, Aug 21
  const after  = "2026-08-22T04:02:00Z";  // 12:02 AM Toronto, Aug 22
  assert.equal(calendarDaysBetween(before, after, TZ), 1);
});

test("sixteen hours apart but NOT crossing local midnight is still 0", () => {
  const a = "2026-08-21T10:00:00Z"; // 6 AM Toronto, Aug 21
  const b = "2026-08-22T02:00:00Z"; // 10 PM Toronto, Aug 21 (16h later, same day)
  assert.equal(calendarDaysBetween(a, b, TZ), 0);
});

test("a multi-day gap counts every calendar day crossed, not just whether any were", () => {
  const start = "2026-08-21T16:00:00Z"; // noon Toronto, Aug 21
  const end = "2026-08-24T16:00:00Z";   // noon Toronto, Aug 24
  assert.equal(calendarDaysBetween(start, end, TZ), 3);
});

test("order matters — going backwards in time returns a negative count, not an absolute value", () => {
  const later = "2026-08-24T16:00:00Z";
  const earlier = "2026-08-21T16:00:00Z";
  assert.equal(calendarDaysBetween(later, earlier, TZ), -3);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
