// scripts/test-systemHealth.js — evaluateProblems() only. collectSystemHealth()
// is I/O (systemctl/df/thermal zones) and stays untested directly, same
// convention as collectMoney/quoteAll elsewhere in this codebase.
//
// Run: node scripts/test-systemHealth.js

import assert from "node:assert/strict";
import { evaluateProblems } from "../lib/systemHealth.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const CFG = {
  systemHealth: {
    cpuTempWarnC: 70,
    cpuTempCriticalC: 80,
    memoryWarnPct: 85,
    diskWarnPct: 85,
    sourceStaleAfterHours: 1,
  },
};

function baseHealth(overrides = {}) {
  return {
    cpuTempC: 45,
    memory: { usedPct: 40 },
    disk: { mountPoint: "/", usedPct: 30 },
    syncthing: { unit: "syncthing@jonbourgy.service", active: true, status: "active" },
    watchdog: { unit: "syncthing-watchdog.timer", active: true, status: "active" },
    mainService: { unit: "pi-secretary.service", active: true, status: "active" },
    sources: [],
    deploy: { status: "idle" },
    ...overrides,
  };
}

group("evaluateProblems — a healthy system reports nothing");

test("all-green health returns zero problems", () => {
  assert.deepEqual(evaluateProblems(baseHealth(), CFG), []);
});

test("null/missing readings (a value that couldn't be collected) are skipped, not flagged", () => {
  const health = baseHealth({ cpuTempC: null, disk: null });
  assert.deepEqual(evaluateProblems(health, CFG), []);
});

group("evaluateProblems — CPU temperature");

test("below warn threshold: no problem", () => {
  assert.deepEqual(evaluateProblems(baseHealth({ cpuTempC: 69 }), CFG), []);
});

test("at/above warn but below critical: one warning", () => {
  const problems = evaluateProblems(baseHealth({ cpuTempC: 72 }), CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "warning");
  assert.equal(problems[0].area, "cpu");
});

test("at/above critical threshold: one critical, not also a warning", () => {
  const problems = evaluateProblems(baseHealth({ cpuTempC: 85 }), CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "critical");
});

group("evaluateProblems — memory and disk");

test("memory over threshold is a warning", () => {
  const problems = evaluateProblems(baseHealth({ memory: { usedPct: 90 } }), CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].area, "memory");
});

test("disk over threshold is a warning and names the mount point", () => {
  const problems = evaluateProblems(baseHealth({ disk: { mountPoint: "/", usedPct: 91 } }), CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].area, "disk");
  assert.match(problems[0].message, /\//);
});

group("evaluateProblems — Syncthing and the watchdog");

test("Syncthing down is critical", () => {
  const problems = evaluateProblems(
    baseHealth({ syncthing: { unit: "syncthing@jonbourgy.service", active: false, status: "inactive" } }),
    CFG
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "critical");
  assert.equal(problems[0].area, "syncthing");
});

test("watchdog timer not scheduled is a warning, not a critical", () => {
  const problems = evaluateProblems(
    baseHealth({ watchdog: { unit: "syncthing-watchdog.timer", active: false, status: "inactive" } }),
    CFG
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "warning");
  assert.equal(problems[0].area, "watchdog");
});

test("watchdog not configured at all (no unit name) is silently skipped, not flagged", () => {
  const problems = evaluateProblems(baseHealth({ watchdog: { unit: null, active: null, status: "not configured" } }), CFG);
  assert.deepEqual(problems, []);
});

test("main service down is critical", () => {
  const problems = evaluateProblems(
    baseHealth({ mainService: { unit: "pi-secretary.service", active: false, status: "failed" } }),
    CFG
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "critical");
  assert.equal(problems[0].area, "service");
});

group("evaluateProblems — Tailscale (round 55 follow-up)");

test("Tailscale connected: no problem", () => {
  const health = baseHealth({ tailscale: { unit: "tailscaled", active: true, status: "Running", ip: "100.82.115.119" } });
  assert.deepEqual(evaluateProblems(health, CFG), []);
});

test("Tailscale configured but not connected is a warning naming the state", () => {
  const health = baseHealth({ tailscale: { unit: "tailscaled", active: false, status: "NeedsLogin", ip: null } });
  const problems = evaluateProblems(health, CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "warning");
  assert.equal(problems[0].area, "tailscale");
  assert.match(problems[0].message, /NeedsLogin/);
});

test("Tailscale not configured at all (no unit name) is silently skipped, not flagged", () => {
  const health = baseHealth({ tailscale: { unit: null, active: null, status: "not configured", ip: null } });
  assert.deepEqual(evaluateProblems(health, CFG), []);
});

test("Tailscale missing from the health snapshot entirely (older caller, or a hand-built test object) is skipped, not a crash", () => {
  const health = baseHealth();
  delete health.tailscale;
  assert.deepEqual(evaluateProblems(health, CFG), []);
});

group("evaluateProblems — the deploy button (round 53 follow-up)")

test("idle or succeeded deploy status is not a problem", () => {
  assert.deepEqual(evaluateProblems(baseHealth({ deploy: { status: "idle" } }), CFG), []);
  assert.deepEqual(evaluateProblems(baseHealth({ deploy: { status: "succeeded", exitCode: 0 } }), CFG), []);
});

test("a running deploy is not (yet) a problem", () => {
  assert.deepEqual(evaluateProblems(baseHealth({ deploy: { status: "running" } }), CFG), []);
});

test("a failed deploy is a warning naming the exit code", () => {
  const problems = evaluateProblems(baseHealth({ deploy: { status: "failed", exitCode: 1 } }), CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "warning");
  assert.equal(problems[0].area, "deploy");
  assert.match(problems[0].message, /exit 1/);
});

group("evaluateProblems — per-source staleness and errors");

test("a source with a recent lastRun and no error is fine", () => {
  const health = baseHealth({ sources: [{ name: "money", lastRun: new Date().toISOString(), lastError: null }] });
  assert.deepEqual(evaluateProblems(health, CFG), []);
});

test("a source that has never run is a warning", () => {
  const health = baseHealth({ sources: [{ name: "money", lastRun: null, lastError: null }] });
  const problems = evaluateProblems(health, CFG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].area, "source");
  assert.match(problems[0].message, /never run/);
});

test("a source stale beyond the threshold is a warning", () => {
  const staleIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const health = baseHealth({ sources: [{ name: "email", lastRun: staleIso, lastError: null }] });
  const problems = evaluateProblems(health, CFG);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /email/);
  assert.match(problems[0].message, /hasn't run/);
});

test("a source with a lastError reports the error, not a duplicate staleness warning", () => {
  const staleIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const health = baseHealth({ sources: [{ name: "brightspace", lastRun: staleIso, lastError: "timeout fetching ics feed" }] });
  const problems = evaluateProblems(health, CFG);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /timeout fetching ics feed/);
});

test("lastError in its real stored shape ({at, message}, per brief/compose.js) is unpacked, not stringified as [object Object]", () => {
  const health = baseHealth({
    sources: [{ name: "money", lastRun: new Date().toISOString(), lastError: { at: new Date().toISOString(), message: "UNIQUE constraint failed" } }],
  });
  const problems = evaluateProblems(health, CFG);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /UNIQUE constraint failed/);
  assert.doesNotMatch(problems[0].message, /\[object Object\]/);
});

test("sourceStaleAfterHours falls back to display.staleAfterHours when omitted", () => {
  const cfg = { systemHealth: {}, display: { staleAfterHours: 2 } };
  const recentButOverOneHour = new Date(Date.now() - 1.5 * 60 * 60 * 1000).toISOString();
  const health = baseHealth({ sources: [{ name: "calendar", lastRun: recentButOverOneHour, lastError: null }] });
  // 1.5h old: stale under the default 1h threshold, fine under a 2h fallback.
  assert.deepEqual(evaluateProblems(health, cfg), []);
});

test("multiple simultaneous problems all come back, critical first", () => {
  const health = baseHealth({
    cpuTempC: 90,
    memory: { usedPct: 95 },
    syncthing: { unit: "x", active: false, status: "inactive" },
  });
  const problems = evaluateProblems(health, CFG);
  assert.equal(problems.length, 3);
  assert.equal(problems[0].level, "critical");
  assert.ok(problems.slice(1).every((p) => p.level !== "critical" || true));
  // critical entries must all sort before any warning
  const levels = problems.map((p) => p.level);
  const firstWarning = levels.indexOf("warning");
  assert.ok(firstWarning === -1 || levels.slice(0, firstWarning).every((l) => l === "critical"));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
