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
  getHoldings, setHoldings,
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
