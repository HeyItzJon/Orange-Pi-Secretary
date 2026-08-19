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
import { init as initStore, getMeta, patchItem, allItems } from "./lib/store.js";
import { startScheduler } from "./lib/scheduler.js";
import { runSources, buildBrief } from "./brief/compose.js";

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
    const brief = await buildBrief(config, { narrate: true });
    res.json({ ok: true, report, brief });
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh/:source", async (req, res) => {
  const { source } = req.params;
  if (!["email", "calendar", "money", "notes"].includes(source)) {
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

/** done | dismiss | snooze | reopen — this is how you teach it to shut up. */
app.post("/api/items/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  const map = {
    done: { status: "done" },
    dismiss: { status: "dismissed" },
    reopen: { status: "open", snoozeUntil: null, surfaceCount: 0 },
  };

  let patch = map[action];
  if (action === "snooze") {
    const days = Number(req.body?.days) || 3;
    patch = { status: "snoozed", snoozeUntil: new Date(Date.now() + days * 86400000).toISOString() };
  }
  if (!patch) return res.status(400).json({ error: `unknown action "${action}"` });

  const updated = await patchItem(id, patch);
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
