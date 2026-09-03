// scripts/test-ask.js — buildAskContext() and buildAskPrompt() only. The
// actual model call in lib/ai.js's ask() is I/O and stays untested
// directly, same convention as collectMoney/collectSystemHealth elsewhere.
//
// Run: node scripts/test-ask.js

import assert from "node:assert/strict";
import { buildAskContext, buildAskPrompt } from "../brief/ask.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const NOW = new Date("2026-09-03T12:00:00-04:00");
const CFG = { timezone: "America/Toronto" };

group("buildAskContext() — tasks and events");

test("no items, no money: still returns a well-shaped empty context", () => {
  const ctx = buildAskContext({ items: [], money: null, marketPulse: null, now: NOW, config: CFG });
  assert.deepEqual(ctx.tasks, []);
  assert.deepEqual(ctx.upcomingEvents, []);
  assert.equal(ctx.portfolio, null);
  assert.deepEqual(ctx.marketIndices, []);
});

test("a dismissed item is excluded entirely — only open (or statusless) items are current facts", () => {
  const items = [
    { id: "1", source: "calendar", title: "Dead item", dueAt: "2026-09-04T10:00:00-04:00", status: "dismissed" },
    { id: "2", source: "calendar", title: "Live item", dueAt: "2026-09-04T10:00:00-04:00", status: "open" },
  ];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.equal(ctx.upcomingEvents.length, 1);
  assert.equal(ctx.upcomingEvents[0].title, "Live item");
});

test("an item with no status at all is treated as open, not excluded", () => {
  const items = [{ id: "1", source: "calendar", title: "No status field", dueAt: "2026-09-04T10:00:00-04:00" }];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.equal(ctx.upcomingEvents.length, 1);
});

test("a calendar event more than 10 days out is left off upcomingEvents", () => {
  const items = [{ id: "1", source: "calendar", title: "Too far", dueAt: "2026-10-01T10:00:00-04:00", status: "open" }];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.deepEqual(ctx.upcomingEvents, []);
});

test("a past calendar event is left off upcomingEvents (this is 'what's coming up', not history)", () => {
  const items = [{ id: "1", source: "calendar", title: "Yesterday", dueAt: "2026-09-02T10:00:00-04:00", status: "open" }];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.deepEqual(ctx.upcomingEvents, []);
});

test("upcoming events are sorted soonest first", () => {
  const items = [
    { id: "1", source: "calendar", title: "Later", dueAt: "2026-09-08T10:00:00-04:00", status: "open" },
    { id: "2", source: "calendar", title: "Sooner", dueAt: "2026-09-04T10:00:00-04:00", status: "open" },
  ];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.deepEqual(ctx.upcomingEvents.map((e) => e.title), ["Sooner", "Later"]);
});

test("task-like items (email needing a reply) are included in tasks, not upcomingEvents", () => {
  const items = [{ id: "1", source: "email", title: "Reply to Sarah", meta: { needsReply: true }, status: "open" }];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.equal(ctx.tasks.length, 1);
  assert.equal(ctx.tasks[0].title, "Reply to Sarah");
  assert.deepEqual(ctx.upcomingEvents, []);
});

test("a non-task-like calendar item (a plain timed meeting) doesn't leak into tasks", () => {
  const items = [{ id: "1", source: "calendar", title: "Coffee with Sam", dueAt: "2026-09-04T10:00:00-04:00", status: "open" }];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.deepEqual(ctx.tasks, []);
});

test("tasks are capped and sorted soonest-due first, undated tasks sort last", () => {
  const items = [
    { id: "1", source: "brightspace", title: "No date", status: "open" },
    { id: "2", source: "brightspace", title: "Due soon", dueAt: "2026-09-04T10:00:00-04:00", status: "open" },
  ];
  const ctx = buildAskContext({ items, now: NOW, config: CFG });
  assert.deepEqual(ctx.tasks.map((t) => t.title), ["Due soon", "No date"]);
});

group("buildAskContext() — portfolio");

test("portfolio is null when no money summary exists yet", () => {
  const ctx = buildAskContext({ money: null, now: NOW, config: CFG });
  assert.equal(ctx.portfolio, null);
});

test("portfolio carries the headline numbers and per-position detail", () => {
  const money = {
    at: "2026-09-03T09:30:00-04:00", base: "CAD", total: 50000, dayPct: 1.2, dayChangeValue: 600,
    weekPct: 2.1, monthPct: -0.5, marketStatus: "open", holdingCount: 2,
    positions: [
      { ticker: "SHOP.TO", name: "Shopify", price: 100, dayChangePct: 5, weightPct: 20, currency: "CAD" },
      { ticker: "AAPL", name: "Apple", price: 200, dayChangePct: -1, weightPct: 10, currency: "USD", stale: true },
    ],
  };
  const ctx = buildAskContext({ money, now: NOW, config: CFG });
  assert.equal(ctx.portfolio.total, 50000);
  assert.equal(ctx.portfolio.base, "CAD");
  // Sorted by |dayChangePct| descending — the 5% mover leads.
  assert.equal(ctx.portfolio.positions[0].ticker, "SHOP.TO");
  assert.equal(ctx.portfolio.positions[1].stale, true);
});

group("buildAskContext() — market indices");

test("indices carry through as label/pct pairs", () => {
  const marketPulse = { indices: [{ symbol: "^GSPTSE", label: "TSX", pct: 0.4 }] };
  const ctx = buildAskContext({ marketPulse, now: NOW, config: CFG });
  assert.deepEqual(ctx.marketIndices, [{ label: "TSX", pct: 0.4 }]);
});

group("buildAskPrompt()");

test("the context JSON and the new question both land in the user message", () => {
  const { system, user } = buildAskPrompt({ context: { tasks: [] }, question: "what's due this week?" });
  assert.match(user, /"tasks":\[\]/);
  assert.match(user, /what's due this week\?/);
  assert.equal(typeof system, "string");
  assert.ok(system.length > 0);
});

test("no history: no 'Conversation so far' section at all", () => {
  const { user } = buildAskPrompt({ context: {}, question: "q" });
  assert.doesNotMatch(user, /Conversation so far/);
});

test("history turns are folded into the transcript in order, labelled by role", () => {
  const history = [
    { role: "user", content: "what's on today" },
    { role: "assistant", content: "Just physio at 2:45." },
  ];
  const { user } = buildAskPrompt({ context: {}, question: "and tomorrow?", history });
  assert.match(user, /Conversation so far/);
  const idxQ = user.indexOf("what's on today");
  const idxA = user.indexOf("Just physio at 2:45");
  const idxNew = user.indexOf("and tomorrow?");
  assert.ok(idxQ > -1 && idxA > idxQ && idxNew > idxA, "turns should appear in order, followed by the new question");
});

test("only the last 10 history turns are kept, so a long session can't balloon every prompt forever", () => {
  const history = Array.from({ length: 15 }, (_, i) => ({ role: "user", content: `turn-${i}` }));
  const { user } = buildAskPrompt({ context: {}, question: "q", history });
  assert.ok(!user.includes("turn-0"), "oldest turns beyond the cap should be dropped");
  assert.ok(user.includes("turn-14"), "the most recent turns should survive");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
