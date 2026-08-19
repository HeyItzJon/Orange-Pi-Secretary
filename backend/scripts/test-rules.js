// scripts/test-rules.js
//
// Tests for the part that decides what you see. The rules engine is pure, so
// it can be tested without touching Gmail, the model, or the clock.
//
//   node scripts/test-rules.js

import assert from "node:assert/strict";
import { selectForBrief, urgency, suppress, isNew } from "../brief/rules.js";
import { triage } from "../sources/email.js";

const NOW = new Date("2026-08-19T07:00:00-04:00");
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

const base = {
  source: "email", kind: "fyi", title: "x", detail: "", url: null,
  dueAt: null, priority: 80, tier: "school", contentHash: "h",
  firstSeen: "2026-08-01T00:00:00Z", lastSeen: NOW.toISOString(),
  status: "open", surfaceCount: 0, lastSurfaced: null, snoozeUntil: null,
  changed: false, meta: {},
};
const item = (over) => ({ ...base, ...over, id: over.id || `i${Math.random()}` });

console.log("\nrules\n");

// ---------------------------------------------------------------- clock
test("urgency escalates as the date approaches", () => {
  assert.equal(urgency(item({ dueAt: inDays(10) }), NOW), null);
  assert.equal(urgency(item({ dueAt: inDays(5) }), NOW), "warning");
  assert.equal(urgency(item({ dueAt: inDays(2) }), NOW), "serious");
  assert.equal(urgency(item({ dueAt: inDays(0.5) }), NOW), "critical");
  assert.equal(urgency(item({ dueAt: inDays(-1) }), NOW), "critical");
});

test("no date means no urgency", () => {
  assert.equal(urgency(item({ dueAt: null }), NOW), null);
});

// ---------------------------------------------------------- suppression
test("an unchanged, undated item goes quiet after maxRepeats", () => {
  const old = item({ surfaceCount: 6 });
  assert.equal(suppress(old, null, { maxRepeats: 6 }), true);
});

test("a deadline keeps its voice no matter how often it has been said", () => {
  const old = item({ surfaceCount: 99, dueAt: inDays(2) });
  assert.equal(suppress(old, "serious", { maxRepeats: 6 }), false);
});

test("a changed item is never suppressed", () => {
  assert.equal(suppress(item({ surfaceCount: 99, changed: true }), null, {}), false);
});

// ------------------------------------------------------------- newness
test("on the very first brief nothing is 'new' — the backlog is baseline", () => {
  assert.equal(isNew(item({ surfaceCount: 0 }), null), false);
});

test("an item first seen after the last brief is new", () => {
  const it = item({ firstSeen: "2026-08-19T06:00:00Z", surfaceCount: 0 });
  assert.equal(isNew(it, "2026-08-18T06:40:00Z"), true);
});

test("something first seen before the last brief is not new", () => {
  const it = item({ firstSeen: "2026-08-10T00:00:00Z", surfaceCount: 2 });
  assert.equal(isNew(it, "2026-08-18T06:40:00Z"), false);
});

// ------------------------------------------------------------ sections
test("every item lands in exactly one section", () => {
  const items = [
    item({ id: "a", kind: "today", source: "calendar", dueAt: inDays(0.2) }),
    item({ id: "b", meta: { needsReply: true }, surfaceCount: 3, firstSeen: "2026-08-01T00:00:00Z" }),
    item({ id: "c", dueAt: inDays(9), surfaceCount: 3, firstSeen: "2026-08-01T00:00:00Z" }),
    item({ id: "d", source: "note", kind: "loose-thread", surfaceCount: 3, firstSeen: "2026-08-01T00:00:00Z" }),
  ];
  const { sections, surfacedIds } = selectForBrief(items, {
    now: NOW, lastBriefAt: "2026-08-18T06:40:00Z", config: {},
  });
  assert.equal(new Set(surfacedIds).size, surfacedIds.length, "an item was shown twice");
  assert.equal(sections.today?.[0].id, "a");
  assert.equal(sections.needsYou?.[0].id, "b");
  assert.equal(sections.comingUp?.[0].id, "c");
  assert.equal(sections.looseThreads?.[0].id, "d");
});

test("brand-new items go to 'new since yesterday', not 'needs you'", () => {
  const items = [item({ id: "n", meta: { needsReply: true }, firstSeen: NOW.toISOString(), surfaceCount: 0 })];
  const { sections } = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T06:40:00Z", config: {} });
  assert.equal(sections.newSince?.[0].id, "n");
  assert.ok(!sections.needsYou);
});

test("but a brand-new CRITICAL item jumps straight to 'needs you'", () => {
  const items = [item({ id: "u", dueAt: inDays(0.5), firstSeen: NOW.toISOString(), surfaceCount: 0 })];
  const { sections } = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T06:40:00Z", config: {} });
  assert.equal(sections.needsYou?.[0].id, "u");
});

test("dismissed and snoozed items never appear", () => {
  const items = [
    item({ id: "x", status: "dismissed", dueAt: inDays(1) }),
    item({ id: "y", status: "done" }),
    item({ id: "z", status: "snoozed", snoozeUntil: inDays(2) }),
  ];
  const { surfacedIds } = selectForBrief(items, { now: NOW, config: {} });
  assert.deepEqual(surfacedIds, []);
});

test("a snooze that has expired brings the item back", () => {
  const items = [item({ id: "z", status: "snoozed", snoozeUntil: inDays(-1), dueAt: inDays(3) })];
  const { surfacedIds } = selectForBrief(items, { now: NOW, config: {} });
  assert.deepEqual(surfacedIds, ["z"]);
});

test("items past the horizon stay quiet", () => {
  const items = [item({ id: "far", dueAt: inDays(40) })];
  const { surfacedIds } = selectForBrief(items, { now: NOW, config: { brief: { comingUpDays: 14 } } });
  assert.deepEqual(surfacedIds, []);
});

test("a quiet day produces an empty brief, not filler", () => {
  const { sections, counts } = selectForBrief([], { now: NOW, config: {} });
  assert.deepEqual(sections, {});
  assert.equal(counts.total, 0);
});

test("needs-you is ordered by urgency, then priority", () => {
  const items = [
    item({ id: "low", meta: { needsReply: true }, priority: 70, surfaceCount: 3, firstSeen: "2026-08-01T00:00:00Z" }),
    item({ id: "urgent", meta: { needsReply: true }, priority: 60, dueAt: inDays(1), surfaceCount: 3, firstSeen: "2026-08-01T00:00:00Z" }),
  ];
  const { sections } = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T00:00:00Z", config: {} });
  assert.equal(sections.needsYou[0].id, "urgent");
});

// ------------------------------------------------------- email triage
console.log("\nemail triage\n");

const rules = {
  tierScores: { opportunity: 100, work: 92, family: 90, school: 78 },
  people: [
    { match: ["mom"], label: "Mom", tier: "family" },
    { match: ["dave leal", "leal"], label: "Dave Leal", tier: "work" },
  ],
  domains: [{ match: "ottawa.ca", label: "City of Ottawa", tier: "work" }],
  topics: {
    opportunity: { score: 100, keywords: ["interview", "co-op"] },
    school: { score: 78, keywords: ["midterm"] },
  },
  mute: ["noreply@"],
};
const msg = (o) => ({ from: "", subject: "", snippet: "", labelIds: [], isNewsletter: false, ...o });

test("an interview outranks everything else", () => {
  const r = triage(msg({ from: "Careers <jobs@corp.com>", subject: "Interview invitation" }), rules);
  assert.equal(r.score, 100);
  assert.equal(r.tier, "opportunity");
});

test("mail from Mom is caught by display name", () => {
  const r = triage(msg({ from: "Mom <someone@gmail.com>", subject: "dinner" }), rules);
  assert.equal(r.tier, "family");
  assert.equal(r.score, 90);
});

test("'mom' does not fire on 'moment'", () => {
  const r = triage(msg({ from: "News <a@b.com>", subject: "A moment of your time" }), rules);
  assert.equal(r.score, 0);
});

test("the work domain is recognised", () => {
  const r = triage(msg({ from: "Someone <s.person@ottawa.ca>", subject: "shift" }), rules);
  assert.equal(r.tier, "work");
});

test("newsletters are dropped", () => {
  const r = triage(msg({ from: "Deals <x@shop.com>", subject: "midterm sale", isNewsletter: true }), rules);
  assert.equal(r.score, 0);
});

test("but a newsletter from a VIP still gets through", () => {
  const r = triage(msg({ from: "Dave Leal <d@ottawa.ca>", subject: "team update", isNewsletter: true }), rules);
  assert.equal(r.tier, "work");
});

test("muted senders are dropped outright", () => {
  const r = triage(msg({ from: "noreply@service.com", subject: "Interview" }), rules);
  assert.equal(r.score, 0);
});

test("ordinary mail scores zero and never reaches the model", () => {
  const r = triage(msg({ from: "Someone <a@b.com>", subject: "hey" }), rules);
  assert.equal(r.score, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}\n`);
