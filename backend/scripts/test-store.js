// scripts/test-store.js — the SQLite-backed store, exercised end to end
// against a throwaway database file so it never touches real data.
//
// Run: node scripts/test-store.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Must be set before the first getDb() call anywhere — store.js reads it
// lazily on each function call, so setting it here (before any import runs
// code that touches the db) is enough.
const TMP_DB = path.join(os.tmpdir(), `pi-secretary-test-${process.pid}.db`);
process.env.STORE_DB_PATH = TMP_DB;

const {
  init, upsertItem, upsertMany, allItems, getItem, patchItem, markSurfaced, prune,
  knownMessageIds, rememberMessageIds, cacheGet, cacheSet, getMeta, setMeta, addUsage,
  recordPortfolioDay, portfolioHistory, recordHoldingDay, holdingHistory,
  getHoldings, setHoldings, dismissItem, suppressPermanently,
  triageItem, resolveTrackedItem, snoozeItem, bumpRemindCounts,
} = await import("../lib/store.js");

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

await init();

group("items — insert, update, preserve what's been learned");

await atest("a new item gets defaults and matching first/lastSeen", async () => {
  const it = await upsertItem({ id: "a1", title: "hello", contentHash: "h1" });
  assert.equal(it.status, "open");
  assert.equal(it.surfaceCount, 0);
  assert.equal(it.firstSeen, it.lastSeen);
});

await atest("re-upserting preserves status/surfaceCount/firstSeen, bumps lastSeen", async () => {
  const first = await upsertItem({ id: "a2", title: "v1", contentHash: "h1" });
  await patchItem("a2", { status: "done", surfaceCount: 3 });
  const again = await upsertItem({ id: "a2", title: "v1 refreshed", contentHash: "h1" });
  assert.equal(again.status, "done");
  assert.equal(again.surfaceCount, 3);
  assert.equal(again.firstSeen, first.firstSeen);
  assert.equal(again.title, "v1 refreshed");
});

await atest("a changed contentHash sets changed = true; identical content does not", async () => {
  await upsertItem({ id: "a3", title: "v1", contentHash: "h1" });
  await markSurfaced(["a3"]); // clears changed
  const same = await upsertItem({ id: "a3", title: "v1", contentHash: "h1" });
  assert.equal(same.changed, false);
  const changed = await upsertItem({ id: "a3", title: "v2", contentHash: "h2" });
  assert.equal(changed.changed, true);
});

await atest("upsertMany returns items in order, allItems returns everything, getItem finds one", async () => {
  const out = await upsertMany([
    { id: "b1", contentHash: "x" },
    { id: "b2", contentHash: "y" },
  ]);
  assert.deepEqual(out.map((i) => i.id), ["b1", "b2"]);
  const all = await allItems();
  assert.ok(all.some((i) => i.id === "b1"));
  assert.ok(all.some((i) => i.id === "b2"));
  assert.equal((await getItem("b1")).id, "b1");
  assert.equal(await getItem("does-not-exist"), null);
});

await atest("patchItem merges fields and returns null for an unknown id", async () => {
  await upsertItem({ id: "c1", contentHash: "x", title: "orig" });
  const patched = await patchItem("c1", { title: "patched" });
  assert.equal(patched.title, "patched");
  assert.equal(await patchItem("nope", { title: "x" }), null);
});

await atest("markSurfaced bumps surfaceCount, stamps lastSurfaced, clears changed", async () => {
  await upsertItem({ id: "d1", contentHash: "x" });
  await markSurfaced(["d1", "does-not-exist"]); // unknown id is silently skipped
  const it = await getItem("d1");
  assert.equal(it.surfaceCount, 1);
  assert.ok(it.lastSurfaced);
  assert.equal(it.changed, false);
});

await atest("a manual dismiss below threshold survives an unchanged refresh, but isn't yet permanent", async () => {
  await upsertItem({ id: "a4", title: "v1", contentHash: "h1" });
  const d = await dismissItem("a4", { threshold: 3, auto: false }); // server.js's dismiss action
  assert.equal(d.dismissStrikes, 1);
  assert.equal(d.permanentlySuppressed, false);
  const again = await upsertItem({ id: "a4", title: "v1", contentHash: "h1" });
  assert.equal(again.status, "dismissed");
});

await atest("an autoDismissed item revives the moment it legitimately reappears", async () => {
  await upsertItem({ id: "a5", title: "v1", contentHash: "h1", meta: { calendarId: "c1" } });
  // The exact shape sources/calendar.js's reconciliation pass writes when a
  // fetch comes back without this item.
  await dismissItem("a5", { threshold: 3, auto: true });
  const revived = await upsertItem({ id: "a5", title: "v1", contentHash: "h1", meta: { calendarId: "c1" } });
  assert.equal(revived.status, "open");
  assert.equal(revived.changed, true, "a revived item should earn the right to be shown again");
  assert.equal(revived.autoDismissed, false, "the flag itself shouldn't linger once revived");
});

await atest("a sub-threshold manual dismiss also revives once the content genuinely changes", async () => {
  await upsertItem({ id: "a6", title: "v1", contentHash: "h1" });
  await dismissItem("a6", { threshold: 3, auto: false });
  const stillGone = await upsertItem({ id: "a6", title: "v1", contentHash: "h1" });
  assert.equal(stillGone.status, "dismissed", "unchanged content should not revive a manual dismiss");
  const revived = await upsertItem({ id: "a6", title: "v2", contentHash: "h2" });
  assert.equal(revived.status, "open", "an edited item is arguably a different ask and deserves a fresh look");
});

await atest("dismissStrikes accumulates across repeated dismissals of the same item", async () => {
  await upsertItem({ id: "a7", title: "v1", contentHash: "h1" });
  const d1 = await dismissItem("a7", { threshold: 3, auto: true });
  assert.equal(d1.dismissStrikes, 1);
  await upsertItem({ id: "a7", title: "v1", contentHash: "h1" }); // revives (autoDismissed)
  const d2 = await dismissItem("a7", { threshold: 3, auto: true });
  assert.equal(d2.dismissStrikes, 2, "the strike count should survive the revival in between");
});

await atest("permanentlySuppressed locks in exactly at the configured threshold, and revival stops", async () => {
  await upsertItem({ id: "a8", title: "v1", contentHash: "h1" });
  await dismissItem("a8", { threshold: 3, auto: true });
  await upsertItem({ id: "a8", title: "v1", contentHash: "h1" }); // strike 1, revives
  await dismissItem("a8", { threshold: 3, auto: true });
  await upsertItem({ id: "a8", title: "v1", contentHash: "h1" }); // strike 2, revives
  const locked = await dismissItem("a8", { threshold: 3, auto: true }); // strike 3 — locks
  assert.equal(locked.dismissStrikes, 3);
  assert.equal(locked.permanentlySuppressed, true);

  // Neither an autoDismissed-wrong-guess nor a genuine content change should
  // revive it anymore — the whole point of the lock.
  const stillLocked = await upsertItem({ id: "a8", title: "v2", contentHash: "h2" });
  assert.equal(stillLocked.status, "dismissed");
  assert.equal(stillLocked.permanentlySuppressed, true);
});

await atest("suppressPermanently locks in immediately, regardless of prior strike count", async () => {
  await upsertItem({ id: "a9", title: "v1", contentHash: "h1" });
  const s = await suppressPermanently("a9");
  assert.equal(s.status, "dismissed");
  assert.equal(s.permanentlySuppressed, true);
  const stillLocked = await upsertItem({ id: "a9", title: "v2", contentHash: "h2" });
  assert.equal(stillLocked.status, "dismissed", "a content change alone shouldn't undo an explicit permanent suppress");
});

await atest("'done' is never touched by any revival/strike logic — a content change doesn't un-finish it", async () => {
  await upsertItem({ id: "a10", title: "v1", contentHash: "h1" });
  await patchItem("a10", { status: "done" });
  const changed = await upsertItem({ id: "a10", title: "v2", contentHash: "h2" });
  assert.equal(changed.status, "done", "finishing a task and then someone editing its description shouldn't un-finish it");
});

group("prune — same rules as before: closed or dateless, and stale");

await atest("an old, done item with no dueAt is pruned; an old item with a future dueAt survives", async () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  await upsertItem({ id: "p1", contentHash: "x", status: "done" });
  await patchItem("p1", { firstSeen: old, lastSeen: old, status: "done" });

  await upsertItem({ id: "p2", contentHash: "x", dueAt: new Date(Date.now() + 86400000).toISOString() });
  await patchItem("p2", { firstSeen: old, lastSeen: old });

  const removed = await prune({ maxAgeDays: 90 });
  assert.ok(removed >= 1);
  assert.equal(await getItem("p1"), null);
  assert.ok(await getItem("p2"));
});

await atest("an old, still-open Brightspace item is pruned even though 'open' items are normally kept — its feed can span an entire enrollment history, and nothing else ever marks it done", async () => {
  const longAgo = new Date(Date.now() - 400 * 86400000).toISOString();
  await upsertItem({ id: "p3", contentHash: "x", source: "brightspace", dueAt: longAgo });

  // A same-age, same-status item from a different source (e.g. a calendar
  // item) must NOT be swept by the same rule — only Brightspace gets this
  // more aggressive treatment.
  await upsertItem({ id: "p4", contentHash: "x", source: "calendar", dueAt: longAgo });

  const removed = await prune({ maxAgeDays: 90, brightspaceMaxPastDays: 14 });
  assert.ok(removed >= 1);
  assert.equal(await getItem("p3"), null, "an old open Brightspace item should be gone");
  assert.ok(await getItem("p4"), "an old open calendar item should NOT be touched by the Brightspace-specific rule");
});

group("triageItem — Inbox decisions (priority / not-priority)");

await atest("triaging 'priority' sets triage and stamps firstTrackedAt", async () => {
  await upsertItem({ id: "tr1", contentHash: "x", title: "Do the thing" });
  const t = await triageItem("tr1", "priority");
  assert.equal(t.triage, "priority");
  assert.ok(t.firstTrackedAt, "the moment it first became Tracked should be recorded");
});

await atest("triaging 'not-priority' sets triage, but does NOT stamp firstTrackedAt", async () => {
  await upsertItem({ id: "tr2", contentHash: "x", title: "Filed away" });
  const t = await triageItem("tr2", "not-priority");
  assert.equal(t.triage, "not-priority");
  assert.equal(t.firstTrackedAt, null, "only becoming Tracked earns a firstTrackedAt stamp");
});

await atest("re-triaging back to priority a second time does NOT reset firstTrackedAt — the reminder history shouldn't lie about how long this has been sitting", async () => {
  await upsertItem({ id: "tr3", contentHash: "x", title: "Back and forth" });
  const first = await triageItem("tr3", "priority");
  const firstStamp = first.firstTrackedAt;
  await triageItem("tr3", "not-priority");
  const again = await triageItem("tr3", "priority");
  assert.equal(again.firstTrackedAt, firstStamp);
});

await atest("triaging an item that doesn't exist returns null, not a crash", async () => {
  assert.equal(await triageItem("nope-tr", "priority"), null);
});

group("resolveTrackedItem — a Tracked item's own final verdict");

await atest("'done' clears any resolutionReason and stamps resolvedAt", async () => {
  await upsertItem({ id: "rt1", contentHash: "x", title: "Ship it" });
  const r = await resolveTrackedItem("rt1", { outcome: "done" });
  assert.equal(r.status, "done");
  assert.equal(r.resolutionReason, null);
  assert.ok(r.resolvedAt);
});

await atest("'dismissed' with reason 'wontdo' is permanent on the first try — no strikes, unlike dismissItem()", async () => {
  await upsertItem({ id: "rt2", contentHash: "x", title: "Nah" });
  const r = await resolveTrackedItem("rt2", { outcome: "dismissed", reason: "wontdo" });
  assert.equal(r.status, "dismissed");
  assert.equal(r.resolutionReason, "wontdo");
  assert.equal(r.permanentlySuppressed, true, "final on the first try, not one of three strikes");
});

await atest("a permanently-resolved item does NOT get revived by a later content change — upsertItem's revive check respects it", async () => {
  await upsertItem({ id: "rt3", contentHash: "h1", title: "Wrong call" });
  await resolveTrackedItem("rt3", { outcome: "dismissed", reason: "wrong" });
  const revived = await upsertItem({ id: "rt3", contentHash: "h2", title: "Wrong call, edited" });
  assert.equal(revived.status, "dismissed", "a deliberate 'wrong' verdict should stick even if the source item's content changes later");
});

group("snoozeItem — remind me later, on a date you actually pick");

await atest("an explicit `until` date wins over the day-count shortcut", async () => {
  await upsertItem({ id: "sn1", contentHash: "x", title: "Later" });
  const until = "2026-09-02T09:00:00.000Z";
  const s = await snoozeItem("sn1", { until, days: 3 });
  assert.equal(s.status, "snoozed");
  assert.equal(s.snoozeUntil, until);
});

await atest("no `until` falls back to the day-count shortcut, default 3 days", async () => {
  await upsertItem({ id: "sn2", contentHash: "x", title: "Later" });
  const before = Date.now();
  const s = await snoozeItem("sn2", {});
  const gotMs = new Date(s.snoozeUntil).getTime();
  assert.ok(gotMs > before + 2.9 * 86400000 && gotMs < before + 3.1 * 86400000, "roughly 3 days out");
});

group("bumpRemindCounts — the once-a-day reminder tally");

await atest("a Tracked (priority) item gets its remindCount bumped once for 'today'", async () => {
  await upsertItem({ id: "bc1", contentHash: "x", title: "Reminded" });
  await triageItem("bc1", "priority");
  const bumped = await bumpRemindCounts("2026-08-28");
  assert.ok(bumped >= 1);
  const item = await getItem("bc1");
  assert.equal(item.remindCount, 1);
  assert.equal(item.lastRemindedOn, "2026-08-28");
});

await atest("calling it again for the SAME day does not double-bump", async () => {
  await upsertItem({ id: "bc2", contentHash: "x", title: "Reminded once" });
  await triageItem("bc2", "priority");
  await bumpRemindCounts("2026-08-28");
  await bumpRemindCounts("2026-08-28");
  const item = await getItem("bc2");
  assert.equal(item.remindCount, 1, "polling the display 40 times in one day must not read as 40 reminders");
});

await atest("calling it on a NEW day bumps again", async () => {
  await upsertItem({ id: "bc3", contentHash: "x", title: "Reminded twice" });
  await triageItem("bc3", "priority");
  await bumpRemindCounts("2026-08-28");
  await bumpRemindCounts("2026-08-29");
  const item = await getItem("bc3");
  assert.equal(item.remindCount, 2);
});

await atest("an Inbox (untriaged) item is never bumped — only Tracked items accrue reminders", async () => {
  await upsertItem({ id: "bc4", contentHash: "x", title: "Still undecided" });
  await bumpRemindCounts("2026-08-28");
  const item = await getItem("bc4");
  assert.equal(item.remindCount, 0);
});

group("gmail message id dedup");

await atest("remembered ids come back as a Set", async () => {
  await rememberMessageIds(["m1", "m2", "m2"]);
  const known = await knownMessageIds();
  assert.ok(known instanceof Set);
  assert.ok(known.has("m1") && known.has("m2"));
});

group("ai cache");

await atest("cacheGet returns null for a miss and the stored value for a hit", async () => {
  assert.equal(await cacheGet("nope"), null);
  await cacheSet("k1", { verdict: "ship it" });
  assert.deepEqual(await cacheGet("k1"), { verdict: "ship it" });
});

group("meta — generic key/value blob");

await atest("getMeta returns the fallback until setMeta has been called", async () => {
  assert.equal(await getMeta("neverSet", "fallback"), "fallback");
  await setMeta("neverSet", { a: 1 });
  assert.deepEqual(await getMeta("neverSet", "fallback"), { a: 1 });
});

await atest("addUsage accumulates per day and getMeta('usage') sees it", async () => {
  await addUsage({ calls: 1, promptTokens: 100, completionTokens: 20 });
  await addUsage({ calls: 2, promptTokens: 50, completionTokens: 5 });
  const usage = await getMeta("usage", {});
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(usage[today].calls, 3);
  assert.equal(usage[today].promptTokens, 150);
});

group("portfolio history — total, unchanged shape");

await atest("recordPortfolioDay upserts by date; portfolioHistory comes back oldest-first", async () => {
  await recordPortfolioDay("2026-08-20", { total: 1000, dayPct: 1, dayValue: 10, base: "CAD" });
  await recordPortfolioDay("2026-08-22", { total: 1010, dayPct: 0.5, dayValue: 5, base: "CAD" });
  await recordPortfolioDay("2026-08-21", { total: 1005, dayPct: -0.2, dayValue: -2, base: "CAD" });
  // re-recording the same date updates it in place rather than duplicating
  await recordPortfolioDay("2026-08-20", { total: 1001, dayPct: 1.1, dayValue: 11, base: "CAD" });

  const h = await portfolioHistory();
  const dates = h.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort());
  const day20 = h.find((r) => r.date === "2026-08-20");
  assert.equal(day20.total, 1001);
  assert.equal(h.filter((r) => r.date === "2026-08-20").length, 1);
});

await atest("portfolioHistory({limit}) returns the most recent N, still oldest-first", async () => {
  const h = await portfolioHistory({ limit: 2 });
  assert.equal(h.length, 2);
  assert.equal(h[0].date < h[1].date, true);
  assert.equal(h[1].date, "2026-08-22");
});

group("holding history — new capability, never existed before");

await atest("recordHoldingDay/holdingHistory round-trip per-ticker daily rows", async () => {
  await recordHoldingDay("2026-08-20", "VFV", { price: 100, dayChangePct: 1, shares: 5, value: 500, currency: "CAD" });
  await recordHoldingDay("2026-08-21", "VFV", { price: 101, dayChangePct: 1, shares: 5, value: 505, currency: "CAD" });
  await recordHoldingDay("2026-08-20", "XEQT", { price: 30, dayChangePct: -1, shares: 10, value: 300, currency: "CAD" });

  const vfv = await holdingHistory("VFV");
  assert.equal(vfv.length, 2);
  assert.equal(vfv[0].date, "2026-08-20");
  assert.equal(vfv[1].price, 101);

  const xeqt = await holdingHistory("XEQT");
  assert.equal(xeqt.length, 1);
  assert.equal(xeqt[0].ticker, "XEQT");
});

group("holdings — the current book, replaced wholesale on each sync");

await atest("setHoldings then getHoldings round-trips, sorted by ticker", async () => {
  await setHoldings([
    { ticker: "VFV", shares: 5, currency: "CAD", sector: "Broad", bookValue: 400, avgCost: 80 },
    { ticker: "AMD", shares: 3, currency: "USD", sector: "Tech", bookValue: 279.42, avgCost: 93.14 },
  ], "vault");
  const holdings = await getHoldings();
  assert.deepEqual(holdings.map((h) => h.ticker), ["AMD", "VFV"]);
  assert.equal(holdings[0].shares, 3);
  assert.equal(holdings[0].source, "vault");
  assert.ok(holdings[0].updatedAt);
});

await atest("a second setHoldings replaces the table wholesale — a sold position disappears", async () => {
  await setHoldings([{ ticker: "AMD", shares: 3, currency: "USD" }, { ticker: "VFV", shares: 5, currency: "CAD" }], "vault");
  await setHoldings([{ ticker: "VFV", shares: 6, currency: "CAD" }], "vault"); // sold AMD, bought more VFV
  const holdings = await getHoldings();
  assert.deepEqual(holdings.map((h) => h.ticker), ["VFV"]);
  assert.equal(holdings[0].shares, 6);
});

await atest("setHoldings with an empty list clears the table", async () => {
  await setHoldings([{ ticker: "XEQT", shares: 10, currency: "CAD" }], "vault");
  await setHoldings([], "vault");
  assert.deepEqual(await getHoldings(), []);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);

// Clean up the throwaway database file (and any WAL sidecar files).
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(TMP_DB + suffix); } catch { /* fine if it never existed */ }
}

process.exit(fail ? 1 : 0);
