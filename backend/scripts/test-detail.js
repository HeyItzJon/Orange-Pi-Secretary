// scripts/test-detail.js — brief/detail.js's own logic: deterministic fact
// construction (always present, no AI), which of the three UI lists an item
// is treated as (inferKind vs. an explicit hintKind from the frontend), and
// the same graceful-null-on-failure contract every other AI pass in this
// app follows (see brief/insights.js's own test file for the same pattern).
//
// No real network call is made. lib/ai.js's ask() checks its cache BEFORE
// looking at the provider (a cache hit returns immediately even with
// provider "off"), so pre-seeding the exact cache key buildItemDetail()
// itself computes lets this test exercise the real parsing path end to end
// without ever calling DeepSeek.
//
// Run: node scripts/test-detail.js

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

const TMP_DB = path.join(os.tmpdir(), `pi-secretary-test-detail-${process.pid}.db`);
process.env.STORE_DB_PATH = TMP_DB;

const { init, cacheSet } = await import("../lib/store.js");
const { cacheKey } = await import("../lib/ids.js");
const { buildItemDetail } = await import("../brief/detail.js");

await init();

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
async function test(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const OFF = { ai: { provider: "off" }, timezone: "America/Toronto" };

// The exact key buildItemDetail() hashes against — see that file's own
// buildItemDetail(). Kept here rather than exported from detail.js, since
// the hash INPUT is an implementation detail that file owns, not a public
// contract (same convention test-insights.js follows for its own keys).
function detailKey(item, kind) {
  return cacheKey("item-detail", { id: item.id, h: item.contentHash, k: kind });
}

// Explicit UTC (Z) throughout, so the expected clock times below don't
// depend on the test runner's own local timezone — 18:00Z is 2:00 PM in
// America/Toronto during EDT (August), same as every other fixture in this
// codebase's own test files (see test-display.js's own `at()` helper).
const eventItem = (o) => ({
  id: "ev1", source: "calendar", title: "Design review", domain: "work",
  categoryLabel: "Meeting", status: "open", dueAt: "2026-08-26T18:00:00Z",
  detail: "Design review", contentHash: "hash-ev1",
  swatch: "work", color: "#c22a1f",
  meta: { allDay: false, end: "2026-08-26T19:00:00Z", location: "Room 204", attendees: 3, description: "Bring the updated slides" },
  ...o,
});

const deadlineItem = (o) => ({
  id: "dl1", source: "email", title: "EOI for Fall 2026 courses due", domain: "school",
  categoryLabel: "Assignment", status: "open", dueAt: "2026-08-26T13:00:00Z",
  detail: "Registrar's Office", contentHash: "hash-dl1",
  unmissable: true,
  meta: { allDay: false, from: "Registrar's Office", body: "Please submit your expression of interest by 9am on August 26th to be considered for Fall 2026 course registration." },
  ...o,
});

const alldayItem = (o) => ({
  id: "ad1", source: "calendar", title: "Payday", domain: "finance",
  categoryLabel: null, status: "open", dueAt: "2026-08-26",
  detail: "", contentHash: "hash-ad1",
  meta: { allDay: true },
  ...o,
});

// ====================================================================
group("facts — deterministic, always present, no AI needed");

await test("an event's facts carry when/duration/location/attendees, kind inferred as 'event'", async () => {
  const item = eventItem();
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.kind, "event");
  assert.equal(out.facts.title, "Design review");
  assert.equal(out.facts.when, "2:00 PM");
  assert.equal(out.facts.duration, "1h");
  assert.equal(out.facts.where, "Room 204");
  assert.equal(out.facts.attendees, 3);
  assert.equal(out.facts.sourceLabel, "Calendar");
});

await test("a deadline's facts carry 'All day' when it's a bare due-date, kind inferred as 'deadline'", async () => {
  const item = deadlineItem({ meta: { allDay: false, from: "Registrar's Office" } });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.kind, "deadline");
  assert.equal(out.facts.sourceLabel, "Email");
  assert.equal(out.facts.from, "Registrar's Office");
});

await test("an all-day item's facts read 'All day', kind inferred as 'allday'", async () => {
  const item = alldayItem();
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.kind, "allday");
  assert.equal(out.facts.when, "All day");
  assert.equal(out.facts.duration, null, "an all-day item never gets a clock duration");
});

await test("status is read straight off the item, never invented", async () => {
  const item = eventItem({ status: "done" });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.status, "done");
});

// ====================================================================
group("colour facts — the modal's own dot must match what it's showing");

await test("an event's facts carry its real calendar swatch/colour, for the modal to match the calendar it's actually on", async () => {
  const item = eventItem();
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.swatch, "work");
  assert.equal(out.facts.color, "#c22a1f");
});

await test("a non-calendar (email) deadline has no swatch/colour of its own — the modal falls back to the priority palette instead", async () => {
  const item = deadlineItem();
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.swatch, null);
  assert.equal(out.facts.color, null);
});

await test("an unmissable deadline's importance recomputes to 'high', the same rule buildDeadlinePool itself uses", async () => {
  const item = deadlineItem();
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.importance, "high");
});

await test("a deadline with a mid-range category weight and not unmissable recomputes to 'medium'", async () => {
  const item = deadlineItem({ unmissable: false, categoryWeight: 50 });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.importance, "medium");
});

await test("a deadline with no weight at all and not unmissable recomputes to 'low', same as buildDeadlinePool's own default", async () => {
  const item = deadlineItem({ unmissable: false, categoryWeight: undefined });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.importance, "low");
});

// ====================================================================
group("hintKind — the frontend's own list-of-origin wins over the server's guess");

await test("a calendar all-day item that's ALSO a deadline gets the deadline framing when clicked from the Deadlines list", async () => {
  // Same item as alldayItem() above, but "Library books due" is exactly
  // the case brief/detail.js's own inferKind() comment describes: it
  // shows up in BOTH the all-day chip row and the Deadlines list.
  const item = alldayItem({ id: "ad2", title: "Library books due", contentHash: "hash-ad2" });
  const asAllDay = await buildItemDetail(item, OFF);
  assert.equal(asAllDay.kind, "allday", "no hint given — falls back to the server's own guess");

  const asDeadline = await buildItemDetail(item, OFF, { hintKind: "deadline" });
  assert.equal(asDeadline.kind, "deadline", "explicit hint from the frontend wins");
});

await test("an invalid/unknown hintKind is ignored, falling back to the server's own guess", async () => {
  const item = eventItem({ id: "ev2", contentHash: "hash-ev2" });
  const out = await buildItemDetail(item, OFF, { hintKind: "banana" });
  assert.equal(out.kind, "event");
});

// ====================================================================
group("graceful degradation — a bad/off/unavailable model never blanks the panel");

await test("provider off, nothing cached — ai is null, facts are still fully populated", async () => {
  const item = eventItem({ id: "ev3", contentHash: "hash-ev3-uncached" });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.ai, null);
  assert.ok(out.facts.title);
});

await test("a well-formed cached answer parses into {summary, action}", async () => {
  const item = eventItem({ id: "ev4", contentHash: "hash-ev4" });
  await cacheSet(detailKey(item, "event"), {
    summary: "A design review with your team to check progress before Friday's deadline.",
    action: "Bring your updated slides.",
  });
  const out = await buildItemDetail(item, OFF);
  assert.deepEqual(out.ai, {
    summary: "A design review with your team to check progress before Friday's deadline.",
    action: "Bring your updated slides.",
  });
});

await test("action is null when the model says there's nothing to prepare", async () => {
  const item = eventItem({ id: "ev5", contentHash: "hash-ev5" });
  await cacheSet(detailKey(item, "event"), { summary: "A routine recurring standup with no notes attached.", action: null });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.ai.action, null);
  assert.ok(out.ai.summary);
});

await test("a malformed cached response (no summary at all) is treated as no answer, not a crash", async () => {
  const item = eventItem({ id: "ev6", contentHash: "hash-ev6" });
  await cacheSet(detailKey(item, "event"), { notTheRightShape: true });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.ai, null);
});

await test("an overlong summary/action is trimmed to the documented cap rather than rejected outright", async () => {
  const item = eventItem({ id: "ev7", contentHash: "hash-ev7" });
  await cacheSet(detailKey(item, "event"), { summary: "x".repeat(2000), action: "y".repeat(500) });
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.ai.summary.length, 700);
  assert.equal(out.ai.action.length, 200);
});

await test("the cache key changes when the item's contentHash changes — a real edit earns a fresh call, a re-click of the unchanged item doesn't", async () => {
  const a = eventItem({ id: "ev8", contentHash: "hash-ev8-v1" });
  const b = eventItem({ id: "ev8", contentHash: "hash-ev8-v2" });
  await cacheSet(detailKey(a, "event"), { summary: "Version one.", action: null });
  const outA = await buildItemDetail(a, OFF);
  const outB = await buildItemDetail(b, OFF); // different contentHash, same id — should NOT see a's cached answer
  assert.equal(outA.ai.summary, "Version one.");
  assert.equal(outB.ai, null, "a genuinely changed item must not silently reuse the old item's cached detail");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
