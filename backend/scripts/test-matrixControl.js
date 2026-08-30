// scripts/test-matrixControl.js — the ESP32 wall's live control state,
// exercised end to end against a throwaway database file so it never
// touches real data.
//
// Run: node scripts/test-matrixControl.js

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Must be set before the first getDb() call anywhere — same convention as
// test-store.js.
const TMP_DB = path.join(os.tmpdir(), `pi-secretary-test-matrix-${process.pid}.db`);
process.env.STORE_DB_PATH = TMP_DB;

// Wherever pids get reused fast enough (seen in practice in at least one
// sandboxed shell), a same-named db left over from an earlier run of this
// script would otherwise get reopened with its old meta rows still in it —
// "defaults" tests silently starting from someone else's leftover state
// instead of a truly empty store. Clear it before opening, in addition to
// the cleanup at the bottom of this file.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(TMP_DB + suffix); } catch { /* fine if it never existed */ }
}

const { init } = await import("../lib/store.js");
const {
  SCREENS, setEnabledScreens, setPinnedScreen, pushNotification, clearNotification,
  fireTestEvent, commandPayload, statusPayload, MatrixControlError,
} = await import("../lib/matrixControl.js");

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
async function rejects(fn, messageIncludes) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof MatrixControlError, `expected a MatrixControlError, got ${err.constructor.name}: ${err.message}`);
    if (messageIncludes) assert.ok(err.message.includes(messageIncludes), `expected "${err.message}" to include "${messageIncludes}"`);
    return;
  }
  throw new Error("expected it to throw, but it didn't");
}

await init();

group("defaults — nothing set yet");

await atest("statusPayload before anything is ever touched: every data screen enabled, nothing pinned, offline", async () => {
  const s = await statusPayload(new Date("2026-08-30T12:00:00Z"));
  assert.deepEqual(s.enabledScreens, ["portfolio", "markets", "holdings", "events", "news"]);
  assert.equal(s.pinnedScreen, null);
  assert.equal(s.notification, null);
  assert.equal(s.testEvent, null);
  assert.equal(s.lastPolledAt, null);
  assert.equal(s.online, false, "never polled yet — must never fabricate 'online'");
});

await atest("the full SCREENS catalog is exposed, weather included and marked as having no data yet", async () => {
  const s = await statusPayload();
  const weather = s.screens.find((sc) => sc.id === "weather");
  assert.ok(weather, "weather should be listed even though it isn't buildable yet");
  assert.equal(weather.hasData, false);
  assert.equal(SCREENS.length, s.screens.length);
});

group("setEnabledScreens — validation");

await atest("rejects a completely unknown id", async () => {
  await rejects(() => setEnabledScreens(["portfolio", "not-a-real-screen"]), "unknown screen");
});

await atest("rejects a real screen id that has no data source yet (weather)", async () => {
  await rejects(() => setEnabledScreens(["portfolio", "weather"]), "no data source");
});

await atest("rejects an empty list — auto-rotate needs at least one screen", async () => {
  await rejects(() => setEnabledScreens([]), "at least one");
});

await atest("rejects a non-array", async () => {
  await rejects(() => setEnabledScreens("portfolio"), "array");
});

await atest("accepts a valid subset, reordered to SCREENS' own canonical order regardless of input order", async () => {
  await setEnabledScreens(["news", "portfolio", "events"]);
  const s = await statusPayload();
  assert.deepEqual(s.enabledScreens, ["portfolio", "events", "news"]);
});

await atest("disabling the currently-pinned screen clears the pin rather than leaving it dangling", async () => {
  await setEnabledScreens(["portfolio", "markets", "holdings", "events", "news"]);
  await setPinnedScreen("markets");
  let s = await statusPayload();
  assert.equal(s.pinnedScreen, "markets");

  await setEnabledScreens(["portfolio", "events"]); // drops "markets"
  s = await statusPayload();
  assert.equal(s.pinnedScreen, null);
});

group("setPinnedScreen — validation");

await atest("rejects an unknown screen id", async () => {
  await rejects(() => setPinnedScreen("nonsense"), "unknown screen");
});

await atest("rejects a real screen that isn't currently enabled", async () => {
  await setEnabledScreens(["portfolio"]);
  await rejects(() => setPinnedScreen("news"), "enable it first");
});

await atest("accepts a screen that is enabled, and null clears it back to auto-rotate", async () => {
  await setEnabledScreens(["portfolio", "news"]);
  await setPinnedScreen("news");
  assert.equal((await statusPayload()).pinnedScreen, "news");
  await setPinnedScreen(null);
  assert.equal((await statusPayload()).pinnedScreen, null);
});

group("pushNotification / clearNotification");

await atest("rejects empty text", async () => {
  await rejects(() => pushNotification("   ", 10), "empty");
});

await atest("rejects text over the 60-character cap", async () => {
  await rejects(() => pushNotification("x".repeat(61), 10), "60 characters");
});

await atest("rejects a non-numeric duration", async () => {
  await rejects(() => pushNotification("hi", "not-a-number"), "number");
});

await atest("clamps a too-short duration up to the 3s floor", async () => {
  const t0 = new Date("2026-08-30T12:00:00Z");
  await pushNotification("Dinner's ready", 1, t0);
  const c = await commandPayload(t0);
  assert.equal(c.notification.secondsRemaining, 3);
});

await atest("clamps a too-long duration down to the 120s ceiling", async () => {
  const t0 = new Date("2026-08-30T12:00:00Z");
  await pushNotification("Long one", 99999, t0);
  const c = await commandPayload(t0);
  assert.equal(c.notification.secondsRemaining, 120);
});

await atest("a live notification counts down and expires on its own, with no separate cleanup step", async () => {
  const start = new Date("2026-08-30T12:00:00Z");
  await pushNotification("Fun screen!", 10, start);

  const midway = await commandPayload(new Date(start.getTime() + 4000));
  assert.equal(midway.notification.text, "Fun screen!");
  assert.equal(midway.notification.secondsRemaining, 6);

  const after = await commandPayload(new Date(start.getTime() + 11_000));
  assert.equal(after.notification, null, "should have expired on its own by 11s into a 10s notification");
});

await atest("clearNotification removes it immediately, before its own expiry", async () => {
  const t0 = new Date("2026-08-30T12:00:00Z");
  await pushNotification("Should disappear early", 60, t0);
  await clearNotification();
  const c = await commandPayload(t0);
  assert.equal(c.notification, null);
});

group("fireTestEvent — for firmware bring-up over the serial monitor");

await atest("rejects an empty label", async () => {
  await rejects(() => fireTestEvent(""), "label");
});

await atest("truncates an overlong label rather than rejecting it outright", async () => {
  await fireTestEvent("x".repeat(100));
  const c = await commandPayload();
  assert.equal(c.testEvent.label.length, 40);
});

await atest("ids increase monotonically across fires, even ones fired in the same millisecond", async () => {
  await fireTestEvent("Button 1");
  const first = (await commandPayload()).testEvent.id;
  await fireTestEvent("Button 2");
  const second = (await commandPayload()).testEvent.id;
  assert.ok(second > first, `expected ${second} > ${first}`);
});

await atest("commandPayload's testEvent carries only id + label, not the internal firedAt timestamp", async () => {
  await fireTestEvent("Button 3");
  const c = await commandPayload();
  assert.deepEqual(Object.keys(c.testEvent).sort(), ["id", "label"]);
});

group("commandPayload as a heartbeat — this is the ONLY thing that should ever mark the device online");

await atest("statusPayload's online flips true right after a commandPayload poll, and false again once enough time passes with no new poll", async () => {
  const t0 = new Date("2026-08-30T12:00:00Z");
  await commandPayload(t0);

  const soonAfter = await statusPayload(new Date(t0.getTime() + 2000), { onlineWithinMs: 10_000 });
  assert.equal(soonAfter.online, true);

  const muchLater = await statusPayload(new Date(t0.getTime() + 60_000), { onlineWithinMs: 10_000 });
  assert.equal(muchLater.online, false);
});

await atest("statusPayload on its own never advances lastPolledAt — only a real device poll (commandPayload) should", async () => {
  const t0 = new Date("2026-08-30T12:00:00Z");
  await commandPayload(t0);
  const before = (await statusPayload()).lastPolledAt;
  await statusPayload();
  await statusPayload();
  const after = (await statusPayload()).lastPolledAt;
  assert.equal(before, after);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);

// Clean up the throwaway database file (and any WAL sidecar files) — same
// convention as test-store.js.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(TMP_DB + suffix); } catch { /* fine if it never existed */ }
}

process.exit(fail ? 1 : 0);
