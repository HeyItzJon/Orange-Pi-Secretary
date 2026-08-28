// scripts/test-sector-profile.js — the cached per-ticker Yahoo fetch's one
// pure piece: the age check. (getSectorProfiles itself hits the network
// and isn't unit tested here, same as lib/stockIdeaDetail.js's
// fetchLiveDetail — see scripts/refresh-sector-profiles.js for exercising
// it for real.)
//
// Run: node scripts/test-sector-profile.js

import assert from "node:assert/strict";
import { isFresh } from "../lib/sectorProfile.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

test("no entry at all is never fresh", () => {
  assert.equal(isFresh(null), false);
  assert.equal(isFresh(undefined), false);
});

test("an entry with no fetchedAt is never fresh", () => {
  assert.equal(isFresh({ sectors: { Energy: 1 } }), false);
});

test("an entry fetched 10 days ago is fresh under the default 30-day window", () => {
  const now = new Date("2026-08-24T00:00:00Z");
  const entry = { fetchedAt: new Date("2026-08-14T00:00:00Z").toISOString() };
  assert.equal(isFresh(entry, now), true);
});

test("an entry fetched 31 days ago is stale under the default 30-day window", () => {
  const now = new Date("2026-08-24T00:00:00Z");
  const entry = { fetchedAt: new Date("2026-07-24T00:00:00Z").toISOString() };
  assert.equal(isFresh(entry, now), false);
});

test("a custom maxAgeDays is honoured", () => {
  const now = new Date("2026-08-24T00:00:00Z");
  const entry = { fetchedAt: new Date("2026-08-20T00:00:00Z").toISOString() }; // 4 days old
  assert.equal(isFresh(entry, now, 3), false);
  assert.equal(isFresh(entry, now, 5), true);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
