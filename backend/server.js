// server.js
//
// Thin HTTP layer over the brief. All the thinking lives in brief/ and
// sources/; this file only routes.

import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { logger } from "./lib/log.js";
import { init as initStore, getMeta, patchItem, dismissItem, suppressPermanently, allItems, portfolioHistory } from "./lib/store.js";
import { startScheduler } from "./lib/scheduler.js";
import { runSources, buildBrief, SOURCE_NAMES } from "./brief/compose.js";
import { buildDisplay } from "./brief/display.js";

const log = logger("server");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const FRONTEND_DIST = path.join(__dirname, "..", "frontend", "dist");

let config = {};
async function loadConfig() {
  config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
  return config;
}

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------- reading

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    provider: config.ai?.provider || "deepseek",
    lastBriefAt: await getMeta("lastBriefAt", null),
  });
});

app.get("/api/brief", async (_req, res) => {
  try {
    const cached = await getMeta("lastBrief", null);
    if (cached) return res.json(cached);
    const brief = await buildBrief(config, { narrate: false, markAsSurfaced: false });
    res.json(brief);
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Recompose from what's already in memory. No source calls, no tokens. */
app.post("/api/brief/rebuild", async (req, res) => {
  try {
    const brief = await buildBrief(config, { narrate: req.body?.narrate !== false });
    res.json(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The always-on screen. Same data as /api/brief, arranged for a small display
 * with no input: fixed zones, a day strip, plain-language priorities.
 */
app.get("/api/display", async (_req, res) => {
  try {
    const names = SOURCE_NAMES;
    const [items, money, history, brief, runs, errs] = await Promise.all([
      allItems(),
      getMeta("moneySummary", null),
      portfolioHistory(),
      getMeta("lastBrief", null),
      Promise.all(names.map((s) => getMeta(`lastRun_${s}`, null))),
      Promise.all(names.map((s) => getMeta(`lastError_${s}`, null))),
    ]);
    const sources = Object.fromEntries(names.map((s, i) => [s, runs[i]]));
    const errors = Object.fromEntries(names.map((s, i) => [s, errs[i]]));
    // Priorities and insights (day titles, the Week page's notes, renamed
    // deadlines — see brief/insights.js) are both computed during compose
    // (cached on a hash of the open work) rather than here, so hitting this
    // endpoint every minute is still free.
    const priorities = brief?.priorities || [];
    const insights = brief?.insights || null;
    res.json(buildDisplay({ items, money, priorities, sources, errors, history, config, now: new Date(), insights }));
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * What each source last did, for the status panel behind the refresh button.
 * The point of this endpoint is that a broken Gmail token should be one click
 * away from visible instead of something you discover a week later.
 */
app.get("/api/sources", async (_req, res) => {
  const out = await Promise.all(
    SOURCE_NAMES.map(async (s) => ({
      name: s,
      lastRun: await getMeta(`lastRun_${s}`, null),
      lastAttempt: await getMeta(`lastAttempt_${s}`, null),
      lastError: await getMeta(`lastError_${s}`, null),
    }))
  );
  res.json({
    sources: out,
    // Everything the pipeline pulls is on one clock now.
    everyMinutes: config.schedule?.pullEveryMinutes ?? 15,
    money: await getMeta("moneySummary", null).then((m) => m && {
      at: m.at, holdingsFrom: m.holdingsFrom, marketState: m.marketState,
      holdingCount: m.holdingCount, stale: m.stale, unavailable: m.unavailable, fx: m.fx,
    }),
  });
});

app.get("/api/items", async (req, res) => {
  const items = await allItems();
  const status = req.query.status;
  res.json(status ? items.filter((i) => i.status === status) : items);
});

app.get("/api/usage", async (_req, res) => {
  res.json({ usage: await getMeta("usage", {}) });
});

app.get("/api/config", async (_req, res) => {
  // Never ship the whole file — it's fine, but keep the habit.
  res.json({
    timezone: config.timezone,
    schedule: config.schedule,
    brief: config.brief,
    calendars: config.calendar?.targets || [],
    provider: config.ai?.provider,
  });
});

// ------------------------------------------------------------- writing

app.post("/api/refresh", async (req, res) => {
  try {
    const report = await runSources(config, { force: Boolean(req.body?.force) });
    // Narration costs a token call, and the refresh button gets pressed to
    // check plumbing far more often than to get a new sentence. Opt in.
    const brief = await buildBrief(config, { narrate: req.body?.narrate === true });
    res.json({ ok: true, report, brief });
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh/:source", async (req, res) => {
  const { source } = req.params;
  if (!SOURCE_NAMES.includes(source)) {
    return res.status(400).json({ error: `unknown source "${source}"` });
  }
  try {
    const report = await runSources(config, { only: source, force: Boolean(req.body?.force) });
    const brief = await buildBrief(config, { narrate: false });
    res.json({ ok: true, report, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * done | dismiss | suppress | snooze | reopen — this is how you teach it to
 * shut up.
 *
 * dismiss and suppress both go through lib/store.js rather than a plain
 * patch: no single dismiss — your own click here, or the system's own
 * automatic guess in sources/calendar.js — is allowed to make an item vanish
 * forever on the first try (Jon: "you are not to dismiss things permanently,
 * even me i shouldnt have that kind of power"). dismiss counts a strike and
 * only locks in for good after config.dismissal.afterCount strikes on the
 * same item; suppress is the explicit "no really, forever" lever that skips
 * straight to that locked state when you already know you want it gone now.
 */
app.post("/api/items/:id/:action", async (req, res) => {
  const { id, action } = req.params;

  let updated;
  if (action === "dismiss") {
    updated = await dismissItem(id, { threshold: config.dismissal?.afterCount ?? 3, auto: false });
  } else if (action === "suppress") {
    updated = await suppressPermanently(id);
  } else {
    const map = {
      done: { status: "done" },
      // A clean slate: reopening should mean reopening, not "reopened but
      // still one strike away from being suppressed again for no reason."
      reopen: {
        status: "open", snoozeUntil: null, surfaceCount: 0,
        dismissStrikes: 0, permanentlySuppressed: false, autoDismissed: false,
      },
    };
    let patch = map[action];
    if (action === "snooze") {
      const days = Number(req.body?.days) || 3;
      patch = { status: "snoozed", snoozeUntil: new Date(Date.now() + days * 86400000).toISOString() };
    }
    if (!patch) return res.status(400).json({ error: `unknown action "${action}"` });
    updated = await patchItem(id, patch);
  }

  if (!updated) return res.status(404).json({ error: "no such item" });

  const brief = await buildBrief(config, { narrate: false, markAsSurfaced: false });
  res.json({ ok: true, item: updated, brief });
});

app.post("/api/config/reload", async (_req, res) => {
  try {
    await loadConfig();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------- frontend

app.use(express.static(FRONTEND_DIST));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
    if (err) res.status(404).send("Frontend not built. Run `npm run build` in /frontend.");
  });
});

// ---------------------------------------------------------------- boot

const PORT = process.env.PORT || 3001;

(async () => {
  await loadConfig();
  await initStore();

  app.listen(PORT, () => {
    log.info(`http://localhost:${PORT}`);
    log.info(`provider: ${config.ai?.provider} · timezone: ${config.timezone}`);
  });

  startScheduler(config);

  // Compose from memory on boot so the dashboard is never blank, but don't
  // hit any external API — a restart shouldn't cost anything.
  try {
    await buildBrief(config, { narrate: false, markAsSurfaced: false });
  } catch (err) {
    log.warn(`initial compose skipped: ${err.message}`);
  }

  if (process.env.REFRESH_ON_BOOT === "1") {
    log.info("REFRESH_ON_BOOT=1 — running a full cycle");
    runSources(config).then(() => buildBrief(config, { narrate: true })).catch((e) => log.error(e.message));
  }
})();
