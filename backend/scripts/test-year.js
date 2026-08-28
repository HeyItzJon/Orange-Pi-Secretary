// scripts/test-year.js — the year page: colour buckets and the
// weekday-aligned grid behind them.
//
// Run: node scripts/test-year.js

import assert from "node:assert/strict";
import { colorBucket, yearGrid, yearStats } from "../brief/display.js";

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
  // Re-tuned to ±0.15 — Jon's own round numbers for the new four-tier
  // scheme (flat / light / darker / darkest), replacing the old ±0.2 dead
  // band.
  assert.equal(colorBucket(0), "flat");
  assert.equal(colorBucket(0.14), "flat");
  assert.equal(colorBucket(-0.14), "flat");
});

test("red deepens as the loss grows", () => {
  assert.equal(colorBucket(-0.15), "r1");   // the light band starts right at 0.15
  assert.equal(colorBucket(-0.3), "r1");
  assert.equal(colorBucket(-0.35), "r2");   // the darker band starts right at 0.35
  assert.equal(colorBucket(-0.7), "r2");
  assert.equal(colorBucket(-1), "r2");      // exactly 1% is still "darker", not darkest
  assert.equal(colorBucket(-1.01), "r3");   // past 1% is the darkest shade
  assert.equal(colorBucket(-5), "r3");
});

test("green deepens as the gain grows, mirroring red exactly by magnitude", () => {
  assert.equal(colorBucket(0.15), "g1");
  assert.equal(colorBucket(0.3), "g1");
  assert.equal(colorBucket(0.35), "g2");
  assert.equal(colorBucket(0.7), "g2");
  assert.equal(colorBucket(1), "g2");
  assert.equal(colorBucket(1.01), "g3");
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

group("yearStats — up/down days, streaks, best/worst, from the grid's own cells");

test("nodata and future cells are skipped entirely, not counted as flat", () => {
  const now = new Date("2026-08-24T18:00:00Z");
  const g = yearGrid([{ date: "2026-08-24", total: 100, dayPct: 1 }], now, "America/Toronto");
  const stats = yearStats(g.cells);
  // 365 cells total; only Jan 1 - Aug 24 (236 days) are non-future, and only
  // Aug 24 itself has real data — everything else in range is nodata.
  assert.equal(stats.trackedDays, 1);
});

test("up/down/flat counts follow the grid's own colour buckets, not the raw sign", () => {
  const cells = [
    { date: "d1", bucket: "g2", dayPct: 0.5 },
    { date: "d2", bucket: "r1", dayPct: -0.2 },
    { date: "d3", bucket: "flat", dayPct: 0.05 }, // a real up day by raw sign, but "flat" on the grid
    { date: "d4", bucket: "nodata", dayPct: null },
    { date: "d5", bucket: "future", dayPct: null },
  ];
  const stats = yearStats(cells);
  assert.equal(stats.upDays, 1);
  assert.equal(stats.downDays, 1);
  assert.equal(stats.flatDays, 1);
  assert.equal(stats.trackedDays, 3);
});

test("a flat day breaks a streak in progress, same as a loss would", () => {
  const cells = [
    { date: "d1", bucket: "g1", dayPct: 0.2 },
    { date: "d2", bucket: "g2", dayPct: 0.5 },
    { date: "d3", bucket: "flat", dayPct: 0.05 },
    { date: "d4", bucket: "g1", dayPct: 0.3 },
  ];
  const stats = yearStats(cells);
  assert.equal(stats.longestUpStreak, 2); // d1-d2, reset at d3, then d4 alone
});

test("the longest streak wins even if a later, shorter one comes after it", () => {
  const cells = [
    { date: "d1", bucket: "r1", dayPct: -0.2 },
    { date: "d2", bucket: "r1", dayPct: -0.2 },
    { date: "d3", bucket: "r1", dayPct: -0.2 },
    { date: "d4", bucket: "g1", dayPct: 0.2 },
    { date: "d5", bucket: "r1", dayPct: -0.2 },
  ];
  const stats = yearStats(cells);
  assert.equal(stats.longestDownStreak, 3);
});

test("best and worst day are picked by actual dayPct, not by bucket depth", () => {
  const cells = [
    { date: "2026-03-01", bucket: "g3", dayPct: 4.2, dayValue: 300 },
    { date: "2026-05-14", bucket: "r3", dayPct: -3.9, dayValue: -280 },
    { date: "2026-06-01", bucket: "g1", dayPct: 0.2, dayValue: 15 },
  ];
  const stats = yearStats(cells);
  assert.equal(stats.bestDay.date, "2026-03-01");
  assert.equal(stats.bestDay.dayValue, 300);
  assert.equal(stats.worstDay.date, "2026-05-14");
});

test("no tracked days at all (a brand new install) gives nulls and zeros, not a crash", () => {
  const stats = yearStats([{ date: "d1", bucket: "nodata", dayPct: null }, { date: "d2", bucket: "future", dayPct: null }]);
  assert.equal(stats.trackedDays, 0);
  assert.equal(stats.bestDay, null);
  assert.equal(stats.worstDay, null);
  assert.equal(stats.longestUpStreak, 0);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
