// lib/systemHealth.js
//
// Round 53 — Jon's ask, roughly verbatim: "a system health page... CPU temp,
// uptime, last restart, pulling frequency, scripts running, all the useful
// stuff... a full dashboard that will highlight any problems I need to fix."
//
// Two halves, same split as everywhere else in this codebase:
//   - collectSystemHealth() is I/O: reads /proc + /sys, shells out to
//     systemctl/df, and reads the meta store for per-source status. Not
//     unit tested directly (same convention as collectMoney/quoteAll).
//   - evaluateProblems() is pure: given a health snapshot + config
//     thresholds, decides what's actually wrong. Fully unit tested — this
//     is the part that has to be right, since it's what decides whether
//     Jon gets bothered about something.
//
// server.js passes sourceNames in explicitly (it already imports
// SOURCE_NAMES from brief/compose.js) rather than this file importing
// brief/compose.js itself — lib/ doesn't reach into brief/, same layering
// as the rest of the app.

import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMeta } from "./store.js";
import { logger } from "./log.js";

const log = logger("systemHealth");
const execFileAsync = promisify(execFile);

// Debian/Armbian on most SBCs exposes at least thermal_zone0; some boards
// number the CPU zone differently or add extra zones for wifi/soc, so try
// a few rather than assuming zone0 is always the right one. Anything that
// doesn't parse to a plausible temperature is skipped rather than trusted.
const THERMAL_ZONES = [0, 1, 2, 3, 4, 5].map((n) => `/sys/class/thermal/thermal_zone${n}/temp`);

async function readCpuTempC() {
  for (const zonePath of THERMAL_ZONES) {
    try {
      const raw = (await fs.readFile(zonePath, "utf8")).trim();
      const milliC = Number(raw);
      if (!Number.isFinite(milliC)) continue;
      const c = milliC / 1000;
      // Sanity range, not a spec: real SBC readings run roughly 20-90C.
      // A parsed-but-implausible value (a mis-scaled zone, a bogus 0 or
      // negative reading) is worth ignoring rather than showing as fact.
      if (c > 0 && c < 150) return Math.round(c * 10) / 10;
    } catch {
      // this zone doesn't exist or isn't readable — try the next one
    }
  }
  log.warn("could not read a plausible CPU temperature from any thermal zone");
  return null;
}

// `systemctl is-active` exits non-zero for inactive/failed/unknown units —
// that is a legitimate answer ("this unit is down"), not a tool failure,
// so the non-zero exit is caught and read rather than treated as an error.
async function readUnitActive(unit) {
  if (!unit) return { unit: null, active: null, status: "not configured" };
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", unit]);
    const status = stdout.trim();
    return { unit, active: status === "active", status };
  } catch (err) {
    const status = (err.stdout || "").trim() || (err.message.includes("ENOENT") ? "systemctl unavailable" : "inactive");
    return { unit, active: false, status };
  }
}

// Tailscale isn't a single systemd unit the way Syncthing is: `tailscaled`
// (the daemon) can be "active" while Tailscale itself is logged out or
// paused, so this checks both the daemon unit and the daemon's own idea of
// its state (`tailscale status --json`'s BackendState) rather than trusting
// systemctl alone. Any failure reading that JSON (CLI not installed, not
// logged in, no permission) is treated as "not connected" rather than a
// crash — same posture as readUnitActive above.
async function readTailscaleStatus(cfg) {
  const unit = cfg.tailscaleUnit || "tailscaled";
  const daemon = await readUnitActive(unit);

  let backendState = null;
  let ip = null;
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
    const parsed = JSON.parse(stdout);
    backendState = parsed.BackendState || null;
    ip = parsed.Self?.TailscaleIPs?.[0] || null;
  } catch {
    // tailscale CLI missing, not logged in, or its output didn't parse —
    // daemon.active (from systemctl) still carries whatever we could tell.
  }

  return {
    unit,
    active: daemon.active && backendState === "Running",
    status: backendState || daemon.status,
    ip,
  };
}

async function readDisk(mountPoint) {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", mountPoint]);
    const line = stdout.trim().split("\n").at(-1);
    const parts = line.trim().split(/\s+/);
    // POSIX df -P: Filesystem 1024-blocks Used Available Capacity Mounted
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availKb = Number(parts[3]);
    if (![totalKb, usedKb, availKb].every(Number.isFinite)) return null;
    return {
      mountPoint,
      totalBytes: totalKb * 1024,
      freeBytes: availKb * 1024,
      usedPct: totalKb > 0 ? Math.round((usedKb / totalKb) * 1000) / 10 : null,
    };
  } catch (err) {
    log.warn(`could not read disk usage for ${mountPoint}: ${err.message}`);
    return null;
  }
}

function readMemory() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedPct = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : null;
  return { totalBytes, freeBytes, usedPct };
}

/**
 * I/O. Everything needed to render the System page and to feed
 * evaluateProblems() below.
 */
export async function collectSystemHealth(config, sourceNames) {
  const cfg = config.systemHealth || {};
  const now = Date.now();

  const [cpuTempC, disk, syncthing, watchdog, mainService, tailscale, sources, deploy] = await Promise.all([
    readCpuTempC(),
    readDisk(cfg.diskMountPoint || "/"),
    readUnitActive(cfg.syncthingUnit),
    // The watchdog is a timer + a oneshot service. A oneshot service is
    // correctly "inactive" between triggered runs — that's not a fault —
    // so what "is the watchdog running" means is "is the timer scheduled",
    // which is why this checks watchdogUnit (a .timer) and not a .service.
    readUnitActive(cfg.watchdogUnit),
    readUnitActive(cfg.mainServiceUnit),
    readTailscaleStatus(cfg),
    Promise.all(
      (sourceNames || []).map(async (s) => ({
        name: s,
        lastRun: await getMeta(`lastRun_${s}`, null),
        lastAttempt: await getMeta(`lastAttempt_${s}`, null),
        lastError: await getMeta(`lastError_${s}`, null),
      }))
    ),
    // Round 53 follow-up — the System page's "Deploy latest" button (see
    // POST /api/system/deploy in server.js). Written by that route and by
    // the boot-time reconcile step it also added (a deploy that's still
    // "running" when the app starts up must actually have succeeded — the
    // restart it triggered is what's booting right now).
    getMeta("deployStatus", { status: "idle" }),
  ]);

  return {
    generatedAt: new Date(now).toISOString(),
    cpuTempC,
    memory: readMemory(),
    disk,
    loadavg: os.loadavg(),
    systemBootAt: new Date(now - os.uptime() * 1000).toISOString(),
    processStartedAt: new Date(now - process.uptime() * 1000).toISOString(),
    syncthing,
    watchdog,
    mainService,
    tailscale,
    sources,
    everyMinutes: config.schedule?.pullEveryMinutes ?? 15,
    deploy,
  };
}

function hoursSince(iso, now) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (now - t) / (1000 * 60 * 60);
}

/**
 * Pure. Takes a health snapshot (from collectSystemHealth, or a
 * hand-built one in tests) plus config, and decides what's actually
 * wrong. Every problem carries a level (critical/warning) and a plain
 * message — this is the list the System page's "problems" banner renders
 * directly, and the future notification-ping hook fires off later.
 */
export function evaluateProblems(health, config) {
  const cfg = config.systemHealth || {};
  const cpuWarnC = cfg.cpuTempWarnC ?? 70;
  const cpuCriticalC = cfg.cpuTempCriticalC ?? 80;
  const memoryWarnPct = cfg.memoryWarnPct ?? 85;
  const diskWarnPct = cfg.diskWarnPct ?? 85;
  const sourceStaleAfterHours = cfg.sourceStaleAfterHours ?? config.display?.staleAfterHours ?? 1;
  const now = Date.now();

  const problems = [];
  const add = (level, area, message) => problems.push({ level, area, message });

  if (typeof health.cpuTempC === "number") {
    if (health.cpuTempC >= cpuCriticalC) {
      add("critical", "cpu", `CPU is at ${health.cpuTempC}°C (critical threshold ${cpuCriticalC}°C)`);
    } else if (health.cpuTempC >= cpuWarnC) {
      add("warning", "cpu", `CPU is at ${health.cpuTempC}°C (warn threshold ${cpuWarnC}°C)`);
    }
  }

  if (typeof health.memory?.usedPct === "number" && health.memory.usedPct >= memoryWarnPct) {
    add("warning", "memory", `Memory is ${health.memory.usedPct}% used (threshold ${memoryWarnPct}%)`);
  }

  if (typeof health.disk?.usedPct === "number" && health.disk.usedPct >= diskWarnPct) {
    add("warning", "disk", `Disk (${health.disk.mountPoint}) is ${health.disk.usedPct}% used (threshold ${diskWarnPct}%)`);
  }

  if (health.syncthing?.active === false) {
    add("critical", "syncthing", `Syncthing is not running (${health.syncthing.status}) — vault data will not sync`);
  }

  if (health.watchdog?.active === false && health.watchdog?.unit) {
    add("warning", "watchdog", `Syncthing watchdog timer (${health.watchdog.unit}) is not scheduled — Syncthing could stay down unnoticed`);
  }

  if (health.mainService?.active === false && health.mainService?.unit) {
    add("critical", "service", `${health.mainService.unit} is not running`);
  }

  if (health.tailscale?.active === false && health.tailscale?.unit) {
    add("warning", "tailscale", `Tailscale isn't connected (${health.tailscale.status || "unknown"}) — remote access via Tailscale won't work until this is fixed`);
  }

  if (health.deploy?.status === "failed") {
    add("warning", "deploy", `Last deploy failed (exit ${health.deploy.exitCode ?? "?"}) — see backend/data/last-deploy.log`);
  }

  for (const s of health.sources || []) {
    if (s.lastError) {
      // lastError is stored as { at, message } (see brief/compose.js's
      // runSources) — but tolerate a plain string too, so a hand-built
      // health object (tests, or a future caller) isn't forced into the
      // object shape just to report an error.
      const msg = typeof s.lastError === "string" ? s.lastError : s.lastError.message || String(s.lastError);
      add("warning", "source", `${s.name} last errored: ${msg}`);
    }
    const stale = hoursSince(s.lastRun, now) > sourceStaleAfterHours;
    if (stale && !s.lastError) {
      const label = s.lastRun ? `hasn't run in over ${sourceStaleAfterHours}h` : "has never run successfully";
      add("warning", "source", `${s.name} ${label}`);
    }
  }

  const order = { critical: 0, warning: 1 };
  return problems.sort((a, b) => order[a.level] - order[b.level]);
}
