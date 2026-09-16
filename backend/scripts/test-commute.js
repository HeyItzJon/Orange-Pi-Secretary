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
import { classifyLocation, applyConservativeBuffer } from "../lib/commute.js";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
