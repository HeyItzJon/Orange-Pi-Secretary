// scripts/test-brightspace.js — the Brightspace feature end to end at the
// level that doesn't need a real feed or a real syllabus PDF: ICS parsing
// against a synthetic fixture, course-code extraction and matching, the
// safety-net unscheduled count, and the syllabus-enrichment merge into
// brief/detail.js's own facts. See sources/brightspace.js and
// brief/brightspace.js for what this is actually testing.
//
// No real network call, no real PDF — same "exercise the real logic
// without a live dependency" shape every other test-*.js file in this repo
// follows.
//
// Run: node scripts/test-brightspace.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const TMP_DB = path.join(os.tmpdir(), `pi-secretary-test-brightspace-${process.pid}.db`);
process.env.STORE_DB_PATH = TMP_DB;

const { init, setCourse } = await import("../lib/store.js");
const { parseFeed, eventToItem, filterRecent } = await import("../sources/brightspace.js");
const { unscheduledCount } = await import("../brief/brightspace.js");
const { buildItemDetail } = await import("../brief/detail.js");
const { extractCourseCode } = await import("../lib/classify.js");

await init();

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
async function test(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

// Real categorise()/domain rules (same file test-rules.js itself loads),
// with the AI provider forced off — eventToItem() needs the real
// "assessment"/"class" category definitions to classify a Brightspace
// title the same way a Google Calendar event would; a bare {ai:{provider:
// "off"}} stub (fine for buildItemDetail's own tests, which set category
// fields directly on their fixtures) has no categories.definitions at all.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFF = {
  ...JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf-8")),
  ai: { provider: "off" },
  timezone: "America/Toronto",
};

// A small synthetic feed: one timed assignment with a course code in the
// title, one all-day entry with no course code at all (a "Reading Week"
// marker — real feeds carry these alongside actual deadlines).
const FIXTURE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//D2L//Brightspace//EN
BEGIN:VEVENT
UID:assign1@brightspace.example
DTSTAMP:20260820T120000Z
DTSTART:20260901T235900Z
SUMMARY:Assignment 1 - ELEC 2507
DESCRIPTION:Submit via the Brightspace dropbox before 11:59pm.
END:VEVENT
BEGIN:VEVENT
UID:quiz1@brightspace.example
DTSTAMP:20260820T120000Z
DTSTART:20260903T140000Z
SUMMARY:Quiz 1 - ELEC 2507
END:VEVENT
BEGIN:VEVENT
UID:readingweek@brightspace.example
DTSTAMP:20260820T120000Z
DTSTART;VALUE=DATE:20260905
SUMMARY:Reading Week
END:VEVENT
END:VCALENDAR
`;

// ====================================================================
group("parseFeed — real ICS parsing against a synthetic fixture");

await test("all three VEVENTs parse out, nothing else from the calendar wrapper leaks in", () => {
  const events = parseFeed(FIXTURE_ICS);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.type === "VEVENT"));
});

await test("a timed event's start is a real Date, not marked all-day", () => {
  const events = parseFeed(FIXTURE_ICS);
  const assign = events.find((e) => e.uid === "assign1@brightspace.example");
  assert.ok(assign.start instanceof Date);
  assert.ok(!assign.start.dateOnly);
});

await test("a VALUE=DATE event IS marked all-day", () => {
  const events = parseFeed(FIXTURE_ICS);
  const rw = events.find((e) => e.uid === "readingweek@brightspace.example");
  assert.ok(rw.start.dateOnly);
});

// ====================================================================
group("eventToItem — turning one parsed VEVENT into a real item");

await test("a course code in the title is extracted onto the item", () => {
  const events = parseFeed(FIXTURE_ICS);
  const assign = events.find((e) => e.uid === "assign1@brightspace.example");
  const item = eventToItem(assign, OFF);
  assert.equal(item.courseCode, "ELEC 2507");
  assert.equal(item.source, "brightspace");
  assert.equal(item.domain, "school", "Brightspace items are always school, regardless of category");
});

await test("an item with no extractable course code still becomes a real item, just with courseCode: null", () => {
  const events = parseFeed(FIXTURE_ICS);
  const rw = events.find((e) => e.uid === "readingweek@brightspace.example");
  const item = eventToItem(rw, OFF);
  assert.equal(item.courseCode, null);
  assert.equal(item.title, "Reading Week");
  assert.equal(item.meta.allDay, true);
});

await test("the same UID always produces the same item id — stable identity across re-pulls", () => {
  const events = parseFeed(FIXTURE_ICS);
  const assign = events.find((e) => e.uid === "assign1@brightspace.example");
  const a = eventToItem(assign, OFF);
  const b = eventToItem(assign, OFF);
  assert.equal(a.id, b.id);
});

await test("a title that reads like a quiz earns the 'Test' category, same rules a Google Calendar quiz would match", () => {
  const events = parseFeed(FIXTURE_ICS);
  const quiz = events.find((e) => e.uid === "quiz1@brightspace.example");
  const item = eventToItem(quiz, OFF);
  assert.equal(item.category, "assessment");
  assert.ok(item.unmissable, "assessment category is unmissable in config.example.json");
});

// ====================================================================
group("filterRecent — dropping a Brightspace feed's old history at collection time");

const FR_NOW = new Date("2026-08-28T00:00:00Z");
const FR_CFG = { brightspace: { maxPastDays: 14 } };

await test("an item due well within the past window survives", () => {
  const items = [{ dueAt: "2026-08-25T12:00:00Z" }]; // 3 days ago
  assert.equal(filterRecent(items, FR_CFG, FR_NOW).length, 1);
});

await test("an item due long before the past window is dropped", () => {
  const items = [{ dueAt: "2024-01-15T12:00:00Z" }]; // over a year ago — an old semester
  assert.equal(filterRecent(items, FR_CFG, FR_NOW).length, 0);
});

await test("an item due in the future always survives", () => {
  const items = [{ dueAt: "2026-09-15T12:00:00Z" }];
  assert.equal(filterRecent(items, FR_CFG, FR_NOW).length, 1);
});

await test("a mixed feed keeps only the recent-or-future items, in order", () => {
  const items = [
    { id: "old", dueAt: "2023-05-01T00:00:00Z" },
    { id: "recent", dueAt: "2026-08-27T00:00:00Z" },
    { id: "future", dueAt: "2026-09-01T00:00:00Z" },
  ];
  assert.deepEqual(filterRecent(items, FR_CFG, FR_NOW).map((i) => i.id), ["recent", "future"]);
});

// ====================================================================
group("unscheduledCount — the safety-net comparison against the calendar");

const bsItem = (o) => ({
  id: "bs1", source: "brightspace", title: "Assignment 1 - ELEC 2507",
  courseCode: "ELEC 2507", dueAt: "2026-09-01T23:59:00Z", ...o,
});
const calItem = (o) => ({
  id: "cal1", source: "calendar", title: "ELEC 2507 assignment due", dueAt: "2026-09-01T23:00:00Z", ...o,
});
const CFG = { brightspace: { auditWindowDays: 14, courseCodeMatchWindowDays: 2 } };
const NOW = new Date("2026-08-28T00:00:00Z");

await test("a Brightspace item with a matching calendar item (same course code, within the window) doesn't count", () => {
  const live = [bsItem(), calItem()];
  assert.equal(unscheduledCount(live, CFG, NOW), 0);
});

await test("a Brightspace item with NO matching calendar item counts as unscheduled", () => {
  const live = [bsItem()];
  assert.equal(unscheduledCount(live, CFG, NOW), 1);
});

await test("a calendar item for a DIFFERENT course doesn't satisfy the match", () => {
  const live = [bsItem(), calItem({ id: "cal2", title: "MSE 3401 lab report due" })];
  assert.equal(unscheduledCount(live, CFG, NOW), 1);
});

await test("a calendar item outside the match window (same course, too far apart in time) doesn't count as a match", () => {
  const live = [bsItem(), calItem({ dueAt: "2026-09-10T23:00:00Z" })]; // 9 days off, window is 2
  assert.equal(unscheduledCount(live, CFG, NOW), 1);
});

await test("a Brightspace item with no extractable course code always counts — nothing safe to match it on", () => {
  const live = [bsItem({ courseCode: null, title: "Reading Week" })];
  assert.equal(unscheduledCount(live, CFG, NOW), 1);
});

await test("a Brightspace item due past auditWindowDays isn't counted yet — too far out to flag", () => {
  const live = [bsItem({ dueAt: "2026-10-01T23:59:00Z" })]; // ~34 days out, window is 14
  assert.equal(unscheduledCount(live, CFG, NOW), 0);
});

await test("a Brightspace item due long in the past isn't counted — it's old history, not something 'not scheduled yet'", () => {
  const live = [bsItem({ dueAt: "2024-01-15T23:59:00Z" })]; // an old semester's assignment
  assert.equal(unscheduledCount(live, CFG, NOW), 0);
});

await test("a Brightspace item due just before NOW still gets the benefit of the doubt (1-day grace)", () => {
  const live = [bsItem({ dueAt: "2026-08-27T23:59:00Z" })]; // a few minutes before NOW
  assert.equal(unscheduledCount(live, CFG, NOW), 1);
});

await test("no Brightspace items at all is a flat zero, not an error", () => {
  assert.equal(unscheduledCount([calItem()], CFG, NOW), 0);
});

await test("a calendar item's own course code, when it doesn't carry one explicitly, is read off its title the same way a Brightspace item's is", () => {
  // calItem() above never sets a top-level courseCode field — this proves
  // the match still works purely off title extraction on the calendar side.
  const live = [bsItem(), calItem()];
  assert.equal(extractCourseCode(calItem().title), "ELEC 2507", "sanity check on the fixture itself");
  assert.equal(unscheduledCount(live, CFG, NOW), 0);
});

// ====================================================================
group("syllabus enrichment — brief/detail.js's buildFacts() merge");

await test("a Brightspace item whose course has a parsed syllabus on file gets real weightings/topics", async () => {
  await setCourse("ELEC 2507", {
    courseName: "Digital Systems II",
    weightings: [{ item: "Assignments", weight: 20, notes: null }, { item: "Final Exam", weight: 40, notes: null }],
    topics: [{ assessment: "Final Exam", chapters: "1-9", scope: "Cumulative" }],
    syllabusFile: "ELEC2507.pdf",
    syllabusHash: "hash-v1",
  });
  const item = { id: "bsd1", source: "brightspace", title: "Assignment 2", courseCode: "ELEC 2507", dueAt: "2026-09-08T23:59:00Z", contentHash: "h1", meta: {} };
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.syllabus.courseName, "Digital Systems II");
  assert.equal(out.facts.syllabus.weightings.length, 2);
  assert.equal(out.facts.syllabus.topics[0].scope, "Cumulative");
});

await test("an item for a course with NO parsed syllabus gets syllabus: null, not a crash or a guess", async () => {
  const item = { id: "bsd2", source: "brightspace", title: "Assignment 1", courseCode: "MSE 3401", dueAt: "2026-09-08T23:59:00Z", contentHash: "h2", meta: {} };
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.syllabus, null);
});

await test("a plain calendar item that happens to mention a course code with a parsed syllabus is enriched too, not just Brightspace's own items", async () => {
  const item = { id: "cald1", source: "calendar", title: "ELEC 2507 midterm", dueAt: "2026-10-01T18:00:00Z", contentHash: "h3", meta: { allDay: false } };
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.syllabus.courseName, "Digital Systems II");
});

await test("an item with no course code at all gets syllabus: null", async () => {
  const item = { id: "cald2", source: "calendar", title: "Team standup", dueAt: "2026-09-08T13:00:00Z", contentHash: "h4", meta: { allDay: false } };
  const out = await buildItemDetail(item, OFF);
  assert.equal(out.facts.syllabus, null);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
