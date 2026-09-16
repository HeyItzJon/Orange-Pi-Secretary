// scripts/test-commute.js — the deterministic parts of the commute/ETA
// feature that don't need a network call or a live store: classifying an
// event's raw location text against configured known places, and the
// conservative-buffer rounding applied to every drive estimate. The
// network-calling parts (computeRoute, refreshCommute) are exercised for
// real by npm run set-maps-api-key's live check, not here — this file is
// about never regressing the "never guess, never misclassify" logic.
//
// Run: node scripts/test-commute.js

import assert from "node:assert/strict";
import {
  classifyLocation,
  applyConservativeBuffer,
  departureBufferFor,
  arrivalBufferFor,
  sameLocationBufferFor,
  isRushHour,
} from "../lib/commute.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const LOCATIONS = {
  carleton: { matchText: ["carleton", "p6"] },
  richcraft: { matchText: ["richcraft"] },
};

group("classifyLocation — matching a raw calendar location against known places");

test("matches Jon's real Carleton P6 location string", () => {
  assert.equal(
    classifyLocation("Carleton University P6 Parking\nCarleton University, Ottawa ON, Canada", LOCATIONS),
    "carleton"
  );
});

test("matches Richcraft's full address form", () => {
  assert.equal(
    classifyLocation("Richcraft Recreation Complex - Kanata, 4101 Innovation Dr, Ottawa, ON K2K 0J3, Canada", LOCATIONS),
    "richcraft"
  );
});

test("is case-insensitive", () => {
  assert.equal(classifyLocation("CARLETON university p6", LOCATIONS), "carleton");
});

test("returns null for an unrecognized location — never guesses a known place", () => {
  assert.equal(classifyLocation("Some Random Coffee Shop, Ottawa", LOCATIONS), null);
});

test("returns null for a missing/empty location, never throws", () => {
  assert.equal(classifyLocation(null, LOCATIONS), null);
  assert.equal(classifyLocation("", LOCATIONS), null);
  assert.equal(classifyLocation(undefined, LOCATIONS), null);
});

test("returns null when no locations are configured, never throws", () => {
  assert.equal(classifyLocation("Carleton University", null), null);
  assert.equal(classifyLocation("Carleton University", {}), null);
});

group("applyConservativeBuffer — always biases pessimistic, per Jon's requirement");

test("adds the given percentage, rounded up", () => {
  assert.equal(applyConservativeBuffer(20, 10), 22);
});

test("rounds up even on a fractional result — never rounds down past the estimate", () => {
  assert.equal(applyConservativeBuffer(21, 10), 24); // 23.1 -> 24
});

test("a 0% buffer returns the input unchanged", () => {
  assert.equal(applyConservativeBuffer(30, 0), 30);
});

test("a missing/undefined pct is treated as 0%, never throws or inflates unexpectedly", () => {
  assert.equal(applyConservativeBuffer(30, undefined), 30);
});

group("buffer helpers — Jon's round-92 requirement: Carleton symmetric, Richcraft arrival-only");

const CFG = {
  locations: {
    carleton: { walkBufferMin: 10 },
    richcraft: { arrivalBufferMin: 5 },
  },
  betweenEventsBufferMin: 10,
};

test("departureBufferFor: Carleton has a walk-to-the-car buffer leaving it", () => {
  assert.equal(departureBufferFor(CFG, "carleton"), 10);
});

test("departureBufferFor: Richcraft has none leaving it — arrival-only per Jon", () => {
  assert.equal(departureBufferFor(CFG, "richcraft"), 0);
});

test("departureBufferFor: home never gets a departure buffer", () => {
  assert.equal(departureBufferFor(CFG, "home"), 0);
});

test("departureBufferFor: no kind (unknown place) is 0, never throws", () => {
  assert.equal(departureBufferFor(CFG, null), 0);
  assert.equal(departureBufferFor(CFG, undefined), 0);
});

test("arrivalBufferFor: Richcraft's own arrivalBufferMin applies arriving", () => {
  assert.equal(arrivalBufferFor(CFG, "richcraft"), 5);
});

test("arrivalBufferFor: Carleton falls back to walkBufferMin (symmetric, no separate arrivalBufferMin)", () => {
  assert.equal(arrivalBufferFor(CFG, "carleton"), 10);
});

test("arrivalBufferFor: an unrecognized/missing kind is 0, never throws", () => {
  assert.equal(arrivalBufferFor(CFG, "somewhere-unknown"), 0);
  assert.equal(arrivalBufferFor(CFG, null), 0);
});

test("sameLocationBufferFor: Carleton's own walkBufferMin covers back-to-back campus events", () => {
  assert.equal(sameLocationBufferFor(CFG, "carleton"), 10);
});

test("sameLocationBufferFor: a place with no walkBufferMin falls back to the config-level default", () => {
  assert.equal(sameLocationBufferFor(CFG, "richcraft"), 10);
});

test("sameLocationBufferFor: no config-level default at all falls back to 10", () => {
  assert.equal(sameLocationBufferFor({ locations: {} }, "richcraft"), 10);
});

group("isRushHour — a deterministic time-window rule, never a model guess");

const RUSH_CFG = {
  rushHours: {
    weekdayOnly: true,
    windows: [
      { label: "morning rush", start: "07:00", end: "09:00" },
      { label: "evening rush", start: "15:30", end: "18:00" },
    ],
  },
};
const TZ = "America/Toronto";

// A known Tuesday (2026-09-15) and a known Saturday (2026-09-19), both in
// commute.js's default timezone, to keep the weekday-only check meaningful.
test("flags a weekday morning-rush time with the window's label", () => {
  assert.equal(isRushHour(new Date("2026-09-15T11:30:00Z"), RUSH_CFG, TZ), "morning rush"); // 7:30am EDT
});

test("flags a weekday evening-rush time with the window's label", () => {
  assert.equal(isRushHour(new Date("2026-09-15T20:00:00Z"), RUSH_CFG, TZ), "evening rush"); // 4:00pm EDT
});

test("returns null outside any configured window", () => {
  assert.equal(isRushHour(new Date("2026-09-15T18:00:00Z"), RUSH_CFG, TZ), null); // 2:00pm EDT
});

test("weekdayOnly: a weekend time inside the same clock window is never flagged", () => {
  assert.equal(isRushHour(new Date("2026-09-19T11:30:00Z"), RUSH_CFG, TZ), null); // Saturday 7:30am EDT
});

test("returns null when no rushHours are configured, never throws", () => {
  assert.equal(isRushHour(new Date(), {}, TZ), null);
  assert.equal(isRushHour(new Date(), null, TZ), null);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
