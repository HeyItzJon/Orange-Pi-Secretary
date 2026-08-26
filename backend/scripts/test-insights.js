// scripts/test-insights.js — brief/insights.js's own logic: the graceful
// null-degradation paths (missing key, provider off, empty input — see
// that file's own header comment on why buildDisplay() never blanks
// because of this), plus the parsing/re-bucketing logic that turns a
// model's JSON answer back into the shape buildDisplay() expects.
//
// No real network call is made. lib/ai.js's ask() checks its cache BEFORE
// looking at the provider (see ask()'s own body — a cache hit returns
// immediately even with provider "off"), so pre-seeding the exact cache
// key each function computes lets this test exercise the real parsing
// path end to end without ever calling DeepSeek.
//
// Run: node scripts/test-insights.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP_DB = path.join(os.tmpdir(), `pi-secretary-test-insights-${process.pid}.db`);
process.env.STORE_DB_PATH = TMP_DB;

const { init, cacheSet } = await import("../lib/store.js");
const { cacheKey } = await import("../lib/ids.js");
const { craftDayInsights, organizeDeadlines, refreshInsights } = await import("../brief/insights.js");

await init();

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
async function test(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const OFF = { ai: { provider: "off" } };

// The exact key each function hashes against — see insights.js's own
// craftDayInsights()/organizeDeadlines(). Kept in this test rather than
// exported from insights.js, since the hash INPUT is an implementation
// detail those functions own, not a public contract.
function dayInsightsKey(days) {
  return cacheKey(
    "day-insights",
    days.map((d) => ({ k: d.key, b: d.busyness, t: (d.timed || []).map((e) => `${e.time}${e.title}`), a: d.allDay }))
  );
}
function deadlinesKey(pool) {
  const items = Object.values(pool || {}).flat();
  return cacheKey("organize-deadlines", items.map((i) => `${i.id}:${i.title}:${i.dueAt}`).sort());
}

const day = (o) => ({
  key: "2026-08-26", label: "Today", dateLabel: "Aug 26", isToday: true,
  busyness: 5, loadPct: 40, eventCount: 1, timed: [], allDay: [], ...o,
});

const deadlineItem = (o) => ({
  id: "x1", title: "Lab report due", categoryLabel: "Assignment", domain: "school",
  dueAt: "2026-08-27T23:59:00", timeLabel: "all day", importance: "medium", ...o,
});

// ====================================================================
group("graceful degradation — every failure path returns null, never throws");

await test("craftDayInsights([]) short-circuits to null without touching the model", async () => {
  assert.equal(await craftDayInsights([], OFF), null);
});

await test("craftDayInsights with the provider off (and no cache) returns null", async () => {
  const days = [day({ key: "2026-01-01T uncached" })];
  assert.equal(await craftDayInsights(days, OFF), null);
});

await test("organizeDeadlines({}) — an empty pool — short-circuits to null", async () => {
  assert.equal(await organizeDeadlines({}, OFF), null);
});

await test("organizeDeadlines with the provider off (and no cache) returns null", async () => {
  const pool = { "2026-01-02T uncached": [deadlineItem({ id: "uncached-1" })] };
  assert.equal(await organizeDeadlines(pool, OFF), null);
});

await test("refreshInsights degrades both halves independently to null", async () => {
  const dayContext = [day({ key: "2026-01-03T uncached" })];
  const deadlinePool = { "2026-01-03T uncached": [deadlineItem({ id: "uncached-2" })] };
  const result = await refreshInsights({ dayContext, deadlinePool, config: OFF });
  assert.deepEqual(result, { days: null, deadlines: null });
});

// ====================================================================
group("craftDayInsights — parses a cached model answer into {title, note} by day key");

await test("a well-formed answer is keyed by each day's own key, in order", async () => {
  const days = [day({ key: "d-today", label: "Today" }), day({ key: "d-tomorrow", label: "Tomorrow", isToday: false })];
  await cacheSet(dayInsightsKey(days), {
    days: [
      { n: 1, title: "Busy shift day", note: "Two shifts back to back, not much room to breathe." },
      { n: 2, title: "Quiet morning", note: "Nothing until the afternoon." },
    ],
  });
  const out = await craftDayInsights(days, OFF);
  assert.deepEqual(out["d-today"], { title: "Busy shift day", note: "Two shifts back to back, not much room to breathe." });
  assert.deepEqual(out["d-tomorrow"], { title: "Quiet morning", note: "Nothing until the afternoon." });
});

await test("an overlong title/note is trimmed to the documented cap rather than rejected outright", async () => {
  const days = [day({ key: "d-long" })];
  await cacheSet(dayInsightsKey(days), {
    days: [{ n: 1, title: "x".repeat(200), note: "y".repeat(1000) }],
  });
  const out = await craftDayInsights(days, OFF);
  assert.equal(out["d-long"].title.length, 80);
  assert.equal(out["d-long"].note.length, 400);
});

await test("a day the model skipped (no matching n) is simply absent from the result, not a crash", async () => {
  const days = [day({ key: "d-a" }), day({ key: "d-b", isToday: false })];
  await cacheSet(dayInsightsKey(days), { days: [{ n: 1, title: "Only day one answered", note: "n/a" }] });
  const out = await craftDayInsights(days, OFF);
  assert.ok(out["d-a"]);
  assert.equal(out["d-b"], undefined);
});

await test("a malformed response (no days array at all) is treated as no answer", async () => {
  const days = [day({ key: "d-malformed" })];
  await cacheSet(dayInsightsKey(days), { notTheRightShape: true });
  assert.equal(await craftDayInsights(days, OFF), null);
});

// ====================================================================
group("organizeDeadlines — parses a cached model answer into {title, importance} by item id");

await test("renames and ranks each item by its own id", async () => {
  const pool = { "2026-08-27": [deadlineItem({ id: "a1", title: "Lab report due" }), deadlineItem({ id: "a2", title: "Pay rent" })] };
  await cacheSet(deadlinesKey(pool), {
    results: [
      { n: 1, title: "Submit MSE 3401 lab report", importance: "high" },
      { n: 2, title: "Rent payment", importance: "high" },
    ],
  });
  const renamed = await organizeDeadlines(pool, OFF);
  assert.deepEqual(renamed.get("a1"), { title: "Submit MSE 3401 lab report", importance: "high", isDeadline: null });
  assert.deepEqual(renamed.get("a2"), { title: "Rent payment", importance: "high", isDeadline: null });
});

await test("an invalid importance value is dropped rather than trusted verbatim", async () => {
  const pool = { "2026-08-27": [deadlineItem({ id: "bad-imp" })] };
  await cacheSet(deadlinesKey(pool), { results: [{ n: 1, title: "Renamed fine", importance: "URGENT!!" }] });
  const renamed = await organizeDeadlines(pool, OFF);
  assert.equal(renamed.get("bad-imp").importance, null);
  assert.equal(renamed.get("bad-imp").title, "Renamed fine");
});

// ====================================================================
group("refreshInsights — re-buckets organizeDeadlines' flat map back by day");

await test("a renamed deadline lands back under the exact day key it started in, title/importance overridden but every other field (domain, categoryLabel, timeLabel, dueAt) preserved from the original pool item", async () => {
  const dayContext = [day({ key: "2026-08-27" })];
  const original = deadlineItem({ id: "z1", title: "Lab report due", importance: "medium", domain: "school", categoryLabel: "Assignment", timeLabel: "all day", dueAt: "2026-08-27T23:59:00" });
  const deadlinePool = { "2026-08-27": [original] };

  await cacheSet(dayInsightsKey(dayContext), { days: [{ n: 1, title: "t", note: "n" }] });
  await cacheSet(deadlinesKey(deadlinePool), { results: [{ n: 1, title: "Submit lab report", importance: "high" }] });

  const result = await refreshInsights({ dayContext, deadlinePool, config: OFF });
  assert.deepEqual(result.deadlines["2026-08-27"], [{
    ...original, title: "Submit lab report", importance: "high",
  }]);
});

await test("an item the model didn't answer for keeps its original rule-based title/importance and full metadata, rather than being dropped", async () => {
  const dayContext = [day({ key: "2026-08-28" })];
  const answered = deadlineItem({ id: "answered", title: "A", domain: "school" });
  const unanswered = deadlineItem({ id: "unanswered", title: "B", domain: "finance", importance: "low" });
  const deadlinePool = { "2026-08-28": [answered, unanswered] };
  await cacheSet(dayInsightsKey(dayContext), { days: [{ n: 1, title: "t", note: "n" }] });
  // Only ONE result for TWO items — organizeDeadlines() itself still
  // returns a Map (truthy), so refreshInsights must merge the miss back
  // onto its original pool item rather than dropping it or inventing a
  // title/importance AI never wrote.
  await cacheSet(deadlinesKey(deadlinePool), { results: [{ n: 1, title: "Renamed A", importance: "high" }] });

  const result = await refreshInsights({ dayContext, deadlinePool, config: OFF });
  const byId = Object.fromEntries(result.deadlines["2026-08-28"].map((i) => [i.id, i]));
  assert.equal(byId.answered.title, "Renamed A");
  assert.equal(byId.unanswered.title, "B", "kept its own original title, untouched");
  assert.equal(byId.unanswered.importance, "low", "kept its own original importance, untouched");
  assert.equal(byId.unanswered.domain, "finance", "full metadata survives even when the model skipped it");
});

await test("when organizeDeadlines itself comes back null, refreshInsights.deadlines is null too — buildDisplay's own rawDeadlinePool fallback takes over", async () => {
  const dayContext = [day({ key: "2026-08-29" })];
  const deadlinePool = { "2026-08-29": [deadlineItem({ id: "uncached-3" })] };
  await cacheSet(dayInsightsKey(dayContext), { days: [{ n: 1, title: "t", note: "n" }] });
  // deadlinesKey deliberately left un-cached, so organizeDeadlines() falls to the OFF provider and returns null.
  const result = await refreshInsights({ dayContext, deadlinePool, config: OFF });
  assert.equal(result.deadlines, null);
  assert.ok(result.days, "the day-titles half still succeeded independently");
});

// ====================================================================
group("organizeDeadlines / refreshInsights — isDeadline filtering (payday etc.)");

await test("organizeDeadlines stores isDeadline alongside title/importance", async () => {
  const pool = { "2026-08-30": [deadlineItem({ id: "payday", title: "Payday" })] };
  await cacheSet(deadlinesKey(pool), {
    results: [{ n: 1, title: "Payday", importance: "low", isDeadline: false }],
  });
  const renamed = await organizeDeadlines(pool, OFF);
  assert.deepEqual(renamed.get("payday"), { title: "Payday", importance: "low", isDeadline: false });
});

await test("a missing/non-boolean isDeadline is stored as null, not coerced", async () => {
  const pool = { "2026-08-30": [deadlineItem({ id: "no-flag" })] };
  await cacheSet(deadlinesKey(pool), { results: [{ n: 1, title: "Renamed", importance: "medium" }] });
  const renamed = await organizeDeadlines(pool, OFF);
  assert.equal(renamed.get("no-flag").isDeadline, null);
});

await test("refreshInsights drops an item the model explicitly marked isDeadline:false (e.g. payday)", async () => {
  const dayContext = [day({ key: "2026-08-30" })];
  const real = deadlineItem({ id: "lab", title: "Lab report due" });
  const payday = deadlineItem({ id: "payday", title: "Payday", domain: "finance" });
  const deadlinePool = { "2026-08-30": [real, payday] };
  await cacheSet(dayInsightsKey(dayContext), { days: [{ n: 1, title: "t", note: "n" }] });
  await cacheSet(deadlinesKey(deadlinePool), {
    results: [
      { n: 1, title: "Submit lab report", importance: "high", isDeadline: true },
      { n: 2, title: "Payday", importance: "low", isDeadline: false },
    ],
  });

  const result = await refreshInsights({ dayContext, deadlinePool, config: OFF });
  const ids = result.deadlines["2026-08-30"].map((i) => i.id);
  assert.deepEqual(ids, ["lab"], "payday was dropped, the real deadline stayed");
});

await test("refreshInsights keeps an item the model didn't answer for at all, even though other items in the same batch were filtered", async () => {
  const dayContext = [day({ key: "2026-08-31" })];
  const filtered = deadlineItem({ id: "birthday", title: "Mom's birthday" });
  const unanswered = deadlineItem({ id: "unanswered", title: "Something due", domain: "school" });
  const deadlinePool = { "2026-08-31": [filtered, unanswered] };
  await cacheSet(dayInsightsKey(dayContext), { days: [{ n: 1, title: "t", note: "n" }] });
  // Only ONE of the two items gets a result — the other is untouched by the model entirely.
  await cacheSet(deadlinesKey(deadlinePool), {
    results: [{ n: 1, title: "Mom's birthday", importance: "low", isDeadline: false }],
  });

  const result = await refreshInsights({ dayContext, deadlinePool, config: OFF });
  const ids = result.deadlines["2026-08-31"].map((i) => i.id);
  assert.deepEqual(ids, ["unanswered"], "the explicitly-flagged item was dropped, the unanswered one was kept");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
