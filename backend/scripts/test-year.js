// scripts/test-year.js — the year page: colour buckets and the
// weekday-aligned grid behind them.
//
// Run: node scripts/test-year.js

import assert from "node:assert/strict";
import { colorBucket, yearGrid } from "../brief/display.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("colorBucket — the split, and its edges");

test("a missing or NaN value is no data, never a guess", () => {
  assert.equal(colorBucket(null), "nodata");
  assert.equal(colorBucket(undefined), "nodata");
  assert.equal(colorBucket(NaN), "nodata");
});

test("the dead band around zero reads as flat, not a faint colour", () => {
  // Widened from ±0.15 to ±0.2 — Jon's own call: "it's probably a few
  // hundred dollars for now", not worth a colour at all.
  assert.equal(colorBucket(0), "flat");
  assert.equal(colorBucket(0.2), "flat");
  assert.equal(colorBucket(-0.2), "flat");
});

test("red deepens as the loss grows", () => {
  assert.equal(colorBucket(-0.3), "r1");
  assert.equal(colorBucket(-1), "r2");
  // The "dark dark" cutoff moved in from ±2 to ±1.5 (Jon's own words:
  // "one or one point five, maybe even two percent... is your dark dark
  // days" — 1.5 was the middle of that range).
  assert.equal(colorBucket(-1.5), "r3");
  assert.equal(colorBucket(-5), "r3");
});

test("green deepens as the gain grows", () => {
  assert.equal(colorBucket(0.3), "g1");
  assert.equal(colorBucket(1), "g2");
  assert.equal(colorBucket(1.5), "g3");
  assert.equal(colorBucket(5), "g3");
});

group("yearGrid — one cell per day of the current year");

test("the grid covers every day of the year, no more and no fewer", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  assert.equal(g.cells.length, 365); // 2026 is not a leap year
});

test("a leap year gets 366 cells", () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  assert.equal(g.cells.length, 366);
});

test("exactly one cell is marked today, and it matches the given date", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  const todays = g.cells.filter((c) => c.today);
  assert.equal(todays.length, 1);
  assert.equal(todays[0].date, "2026-08-24");
});

test("days after today are 'future' and never coloured by a stray history row", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  // A history entry that (by mistake or clock skew) names a future date.
  const g = yearGrid([{ date: "2026-12-25", total: 1, dayPct: 3 }], now, "America/Toronto");
  const xmas = g.cells.find((c) => c.date === "2026-12-25");
  assert.equal(xmas.future, true);
  assert.equal(xmas.bucket, "future");
  assert.equal(xmas.dayPct, null, "a future date never surfaces a dayPct, even if one was recorded");
});

test("a day with no history entry at all is no data", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  const jan5 = g.cells.find((c) => c.date === "2026-01-05");
  assert.equal(jan5.dayPct, null);
  assert.equal(jan5.bucket, "nodata");
});

test("an old-format history row — total only, no dayPct — is no data, not a guess from the total", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  // This is exactly the shape of the four real rows already on disk from
  // before this feature existed: {date, total}, no dayPct.
  const g = yearGrid([{ date: "2026-08-19", total: 63139.6 }], now, "America/Toronto");
  const day = g.cells.find((c) => c.date === "2026-08-19");
  assert.equal(day.dayPct, null);
  assert.equal(day.bucket, "nodata");
});

test("a real dayPct on record colours that day and only that day", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid(
    [
      { date: "2026-08-21", total: 100, dayPct: -3.4 },
      { date: "2026-08-24", total: 101, dayPct: 0.8 },
    ],
    now,
    "America/Toronto"
  );
  const worse = g.cells.find((c) => c.date === "2026-08-21");
  const better = g.cells.find((c) => c.date === "2026-08-24");
  assert.equal(worse.bucket, "r3");
  assert.equal(better.bucket, "g2");
});

test("dayValue rides along with dayPct, rounded to the nearest dollar", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([{ date: "2026-08-24", total: 69612.9, dayPct: 1.24, dayValue: 862.37 }], now, "America/Toronto");
  const day = g.cells.find((c) => c.date === "2026-08-24");
  assert.equal(day.dayValue, 862);
});

test("a row with dayPct but no dayValue — the shape every existing row has right now — doesn't fabricate one", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([{ date: "2026-08-24", total: 69612.9, dayPct: 1.24 }], now, "America/Toronto");
  const day = g.cells.find((c) => c.date === "2026-08-24");
  assert.equal(day.dayPct, 1.24);
  assert.equal(day.dayValue, null);
});

test("a future date never surfaces a dayValue either, even if one was recorded", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([{ date: "2026-12-25", total: 1, dayPct: 3, dayValue: 500 }], now, "America/Toronto");
  const xmas = g.cells.find((c) => c.date === "2026-12-25");
  assert.equal(xmas.dayValue, null);
});

test("the first cell's weekday matches Jan 1's actual day of week", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  const jan1 = g.cells[0];
  assert.equal(jan1.date, "2026-01-01");
  // Jan 1, 2026 is a Thursday.
  assert.equal(jan1.weekday, 4);
});

test("week numbers only increase, so a column never gets used twice", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  for (let i = 1; i < g.cells.length; i++) {
    assert.ok(g.cells[i].week >= g.cells[i - 1].week, `cell ${i} went backwards in week`);
  }
});

test("months are labelled once each, at the column their 1st falls in", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([], now, "America/Toronto");
  assert.equal(g.months.length, 12);
  assert.equal(g.months[0].label, "Jan");
  assert.equal(g.months[7].label, "Aug");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
