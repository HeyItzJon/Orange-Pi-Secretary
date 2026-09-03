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
import { spawn } from "node:child_process";

import { logger } from "./lib/log.js";
import { init as initStore, getMeta, setMeta, getItem, patchItem, dismissItem, suppressPermanently, triageItem, resolveTrackedItem, snoozeItem, allItems, portfolioHistory } from "./lib/store.js";
import { startScheduler } from "./lib/scheduler.js";
import { runSources, buildBrief, SOURCE_NAMES } from "./brief/compose.js";
import { buildDisplay, shortTicker } from "./brief/display.js";
import { buildItemDetail } from "./brief/detail.js";
import { getTickerDetail } from "./lib/stockIdeaDetail.js";
import {
  setEnabledScreens, setPinnedScreen, pushNotification, clearNotification,
  fireTestEvent, commandPayload, statusPayload, MatrixControlError,
} from "./lib/matrixControl.js";
import { collectSystemHealth, evaluateProblems } from "./lib/systemHealth.js";
import { buildAskContext, buildAskPrompt } from "./brief/ask.js";
import { ask } from "./lib/ai.js";

const log = logger("server");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const FRONTEND_DIST = path.join(__dirname, "..", "frontend", "dist");
const REPO_ROOT = path.join(__dirname, "..");
const DEPLOY_LOG_PATH = path.join(__dirname, "data", "last-deploy.log");

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

// Everything both /api/display and /api/ask need to know about the
// current state of the world — pulled out so the chat endpoint (round 55
// follow-up) reads from exactly the same live data the dashboard itself
// renders from, rather than a second, potentially-drifting copy of this
// same Promise.all.
async function loadCurrentFacts() {
  const names = SOURCE_NAMES;
  const [items, money, marketPulse, history, brief, runs, errs] = await Promise.all([
    allItems(),
    getMeta("moneySummary", null),
    getMeta("marketPulse", null),
    portfolioHistory(),
    getMeta("lastBrief", null),
    Promise.all(names.map((s) => getMeta(`lastRun_${s}`, null))),
    Promise.all(names.map((s) => getMeta(`lastError_${s}`, null))),
  ]);
  const sources = Object.fromEntries(names.map((s, i) => [s, runs[i]]));
  const errors = Object.fromEntries(names.map((s, i) => [s, errs[i]]));
  // Priorities and insights (day titles, the Week page's notes, renamed
  // deadlines — see brief/insights.js) are both computed during compose
  // (cached on a hash of the open work) rather than here, so hitting either
  // endpoint every minute is still free.
  const priorities = brief?.priorities || [];
  const insights = brief?.insights || null;
  return { items, money, marketPulse, history, sources, errors, priorities, insights };
}

/**
 * The always-on screen. Same data as /api/brief, arranged for a small display
 * with no input: fixed zones, a day strip, plain-language priorities.
 */
app.get("/api/display", async (_req, res) => {
  try {
    const { items, money, marketPulse, priorities, sources, errors, history, insights } = await loadCurrentFacts();
    res.json(buildDisplay({ items, money, marketPulse, priorities, sources, errors, history, config, now: new Date(), insights }));
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Round 55 follow-up — Jon: "a helper chat that has access to all the
// site information," to ask about his schedule, tasks, and portfolio in
// plain language. buildAskContext() (brief/ask.js) turns the same live
// facts /api/display renders from into a compact, model-friendly
// snapshot — not that endpoint's own rendered output, which is shaped for
// seven UI pages, not a question. One AI call per question, same cost
// shape as the on-demand item-detail lookups elsewhere in this app — no
// agent loop, no tool-calling, the model only ever answers from what's
// handed to it. `history` is kept client-side (see Display.jsx) and sent
// back each turn rather than stored here; capped inside buildAskPrompt()
// so a long chat session can't balloon every subsequent prompt forever.
app.post("/api/ask", async (req, res) => {
  const question = String(req.body?.message || "").trim();
  if (!question) return res.status(400).json({ error: "message is required" });
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  try {
    const { items, money, marketPulse } = await loadCurrentFacts();
    const context = buildAskContext({ items, money, marketPulse, now: new Date(), config });
    const { system, user } = buildAskPrompt({ context, question, history });
    const answer = await ask({ system, user, config, json: false, maxTokens: 500, cacheAs: null });
    if (answer == null) {
      return res.status(502).json({ error: "The AI provider didn't answer — check DEEPSEEK_API_KEY and try again." });
    }
    res.json({ answer });
  } catch (err) {
    log.error(`POST /api/ask failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});


/**
 * Slim endpoint for the ESP32 LED wall. Returns everything the firmware's
 * pages need — ticker (markets + top movers), today's events, top holdings —
 * ~2-3KB JSON. Polled every 30 seconds from the ESP32 over WiFi.
 *
 * IMPORTANT: this endpoint makes ZERO external API calls of its own. Every
 * field below is read straight out of meta blobs that the regular 15-minute
 * pull cycle (runSources → collectMoney / collectMarketNews) already wrote:
 *   - moneySummary.positions[].dayChangePct → gainers/losers
 *   - marketPulse.indices[].pct             → TSX/NASDAQ/S&P ticker line
 * If you want fresher numbers, raise config.schedule.pullEveryMinutes rather
 * than adding a fetch here — this route just reads what's already cached.
 */
app.get("/api/matrix", async (_req, res) => {
  try {
    const now = new Date();
    const [items, money, marketPulse, brief] = await Promise.all([
      allItems(),
      getMeta("moneySummary", null),
      getMeta("marketPulse", null),
      getMeta("lastBrief", null),
    ]);

    // Portfolio: total value, day change ($), day change (%)
    const portfolio = money
      ? {
          total: Math.round((money.total || 0) * 100) / 100,
          dayChange: Math.round((money.dayChangeValue || 0) * 100) / 100,
          dayChangePercent: Math.round((money.dayPct || 0) * 100) / 100,
        }
      : null;

    // Market indices (TSX / NASDAQ / S&P) — from marketPulse, refreshed by
    // sources/marketNews.js on the same 15-minute cycle. No fetch here.
    const shortLabel = (label) => (label === "S&P 500" ? "S&P" : label.toUpperCase());
    const markets = (marketPulse?.indices || [])
      .filter((i) => i.pct != null)
      .map((i) => ({
        symbol: shortLabel(i.label),
        changePercent: Math.round(i.pct * 100) / 100,
      }));

    // Top 3 gainers / losers by TODAY's move, from the positions the money
    // source already priced this pull — same dayChangePct the Finances page
    // shows on each holding row.
    const movers = (money?.positions || [])
      .filter((p) => p.dayChangePct != null)
      .map((p) => ({
        symbol: p.ticker.replace(/\.(TO|V|NE|CN)$/i, ""),
        changePercent: Math.round(p.dayChangePct * 100) / 100,
      }));
    const gainers = [...movers].sort((a, b) => b.changePercent - a.changePercent).slice(0, 3);
    const losers = [...movers].sort((a, b) => a.changePercent - b.changePercent).slice(0, 3);

    // Events: today's events only, with busy level
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);

    const todayEvents = items
      .filter((i) => i.source === "calendar" && i.dueAt?.startsWith(today) && i.status === "open")
      .map((e) => ({
        time: e.clockTime || e.dueAt?.slice(11, 16) || "",
        title: (e.title || "").slice(0, 30), // truncate for display
        busyLevel: e.meta?.busyLevel || "medium", // "busy" | "medium" | "light"
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    // Daily busy score (0-100)
    const dailyBusyPercent = brief?.insights?.busyPercent || 0;

    // Top holdings (top 5 by value) — same shape the Holdings page already uses
    const holdings = money?.positions
      ? money.positions.slice(0, 5).map((p) => ({
          symbol: p.ticker.replace(/\.(TO|V|NE|CN)$/i, ""),
          value: Math.round(p.value || 0),
          dayChangePercent: p.dayChangePct || 0,
          weightPercent: Math.round((p.weightPct || 0) * 10) / 10,
        }))
      : [];

    // Headlines for a "News" screen — marketPulse is already being fetched
    // above for the ticker, so this is free: no new source, no new call.
    // Same truncate-for-display convention as todayEvents' title above.
    const news = (marketPulse?.headlines || []).slice(0, 6).map((h) => ({
      title: (h.title || "").slice(0, 60),
      source: h.source || null,
    }));

    // Whether anything actually traded today, per the Round 49 weekend-
    // color fix (sources/money.js's marketOpen gate) — free to include here
    // since `money` is already fetched above. Lets the firmware show an
    // honest "Markets are closed" screen on a weekend/holiday instead of a
    // stale weekday portfolio number presented as current.
    const marketOpen = money?.marketStatus != null;

    res.json({
      timestamp: now.getTime(),
      lastRefresh: money?.at || null,
      portfolio,
      markets, // TSX, NASDAQ, S&P with % change
      gainers, // Top 3 holdings up today
      losers, // Top 3 holdings down today
      events: todayEvents,
      dailyBusyPercent,
      holdings,
      news,
      marketOpen,
    });
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Live CONTROL for the ESP32 wall — separate from /api/matrix's DATA above.
 * See lib/matrixControl.js's own header comment for the full design (Round
 * 49 §6, "live control of the ESP32 displays from the web page", Tier 0).
 *
 * /api/matrix/command is what the firmware itself polls, fast (1-2s) — a
 * small, cheap blob, no external calls, matching how /api/matrix already
 * only reads cached meta. /api/matrix/status is the same information plus
 * the bits only a human needs (the full screen catalog, when the device
 * last actually checked in) — kept as its own route specifically so the web
 * control page reading its own state never gets mistaken for a real device
 * poll (see commandPayload/statusPayload's own comments on why only one of
 * them is allowed to advance "last seen").
 */
app.get("/api/matrix/command", async (_req, res) => {
  try {
    res.json(await commandPayload());
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/matrix/status", async (_req, res) => {
  try {
    res.json(await statusPayload());
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/screens", async (req, res) => {
  try {
    res.json(await setEnabledScreens(req.body?.enabledScreens));
  } catch (err) {
    if (err instanceof MatrixControlError) return res.status(400).json({ error: err.message });
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/pin", async (req, res) => {
  try {
    res.json(await setPinnedScreen(req.body?.screen ?? null));
  } catch (err) {
    if (err instanceof MatrixControlError) return res.status(400).json({ error: err.message });
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/notify", async (req, res) => {
  try {
    res.json(await pushNotification(req.body?.text, req.body?.durationSeconds));
  } catch (err) {
    if (err instanceof MatrixControlError) return res.status(400).json({ error: err.message });
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/notify/clear", async (req, res) => {
  try {
    res.json(await clearNotification());
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/test", async (req, res) => {
  try {
    res.json(await fireTestEvent(req.body?.label));
  } catch (err) {
    if (err instanceof MatrixControlError) return res.status(400).json({ error: err.message });
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

// Round 53 — the System page. One combined snapshot (host stats, the
// Syncthing/watchdog/main-service units, per-source status) plus the
// derived problem list, so the frontend gets a ready-to-render dashboard
// in a single poll rather than assembling it from several endpoints.
app.get("/api/system-health", async (_req, res) => {
  try {
    const health = await collectSystemHealth(config, SOURCE_NAMES);
    const problems = evaluateProblems(health, config);
    res.json({ ...health, problems });
  } catch (err) {
    log.error(`GET /api/system-health failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/items", async (req, res) => {
  const items = await allItems();
  const status = req.query.status;
  res.json(status ? items.filter((i) => i.status === status) : items);
});

/**
 * On-demand AI detail for exactly one item — a full summary, an actionable
 * next step — never generated during compose/poll (see brief/detail.js's
 * own header for why). Only ever called when a person actually taps an
 * item on the Today page, so a screen nobody interacts with never spends
 * a token on it. `?kind=event|deadline|allday` is an optional hint from
 * the frontend saying which list the click came from (an item can appear
 * in more than one — see brief/detail.js's inferKind() comment); anything
 * else falls back to the server's own best guess.
 */
app.get("/api/items/:id/detail", async (req, res) => {
  try {
    const item = await getItem(req.params.id);
    if (!item) return res.status(404).json({ error: "no such item" });
    const detail = await buildItemDetail(item, config, { hintKind: req.query.kind });
    res.json(detail);
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * On-demand AI detail for the Finances page's one daily "Worth a look"
 * stock idea (see lib/stockIdeaDetail.js) — same click-to-load, cache-until-
 * the-next-calendar-day shape as the item detail above, but for a live
 * Yahoo pull rather than a local item, so the whole result (facts + AI) is
 * cached together for the day rather than just the AI half.
 *
 * `:ticker` arrives as the SHORT display symbol the frontend was actually
 * shown (see shortTicker in brief/display.js — it strips a Canadian
 * exchange suffix for display). This looks it up against today's real
 * stockIdea candidates (which still carry the full Yahoo symbol, e.g.
 * "SHOP.TO") two ways at once: it recovers the real symbol a quoteSummary
 * call actually needs, and it doubles as the input validation — a ticker
 * that isn't one of today's actual candidates 404s rather than silently
 * running an arbitrary Yahoo lookup for whatever a modified client sends.
 */
app.get("/api/stock-idea/:ticker/detail", async (req, res) => {
  try {
    const requested = String(req.params.ticker || "").toUpperCase();
    const money = await getMeta("moneySummary", null);
    const candidate = (money?.stockIdea || []).find((c) => shortTicker(c.symbol).toUpperCase() === requested);
    if (!candidate) return res.status(404).json({ error: "not today's stock idea" });

    const detail = await getTickerDetail(config, candidate.symbol, { context: "idea" });
    res.json(detail);
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The same on-demand detail panel (lib/stockIdeaDetail.js), for a ticker
 * that's already an actual holding rather than today's suggested idea —
 * Round 48's "tap a row in All Positions" ask. Same shape as the route
 * above: `:ticker` arrives short (shortTicker'd for display), looked up
 * against `money.positions` (which carry the full Yahoo symbol, e.g.
 * "SHOP.TO") both to recover the real symbol and as input validation — a
 * ticker that isn't an actual current position 404s rather than running an
 * arbitrary Yahoo lookup for whatever a modified client sends.
 */
app.get("/api/positions/:ticker/detail", async (req, res) => {
  try {
    const requested = String(req.params.ticker || "").toUpperCase();
    const money = await getMeta("moneySummary", null);
    const position = (money?.positions || []).find((p) => shortTicker(p.ticker).toUpperCase() === requested);
    if (!position) return res.status(404).json({ error: "not a current holding" });

    const detail = await getTickerDetail(config, position.ticker, { context: "holding" });
    res.json(detail);
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
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
 * done | dismiss | suppress | snooze | reopen | priority | not-priority |
 * wontdo | wrong — this is how you teach it to shut up, and (new, see the
 * Tasks-page plan) how you triage and resolve.
 *
 * dismiss and suppress both go through lib/store.js rather than a plain
 * patch: no single dismiss — your own click here, or the system's own
 * automatic guess in sources/calendar.js — is allowed to make an item vanish
 * forever on the first try (Jon: "you are not to dismiss things permanently,
 * even me i shouldnt have that kind of power"). dismiss counts a strike and
 * only locks in for good after config.dismissal.afterCount strikes on the
 * same item; suppress is the explicit "no really, forever" lever that skips
 * straight to that locked state when you already know you want it gone now.
 *
 * priority | not-priority (Inbox → Tracked or filed away) and wontdo | wrong
 * (a Tracked item's own resolution) are the new Tasks-page triage actions —
 * see triageItem()/resolveTrackedItem() in lib/store.js for why these are
 * deliberately NOT routed through dismiss's strike-counting: a triage
 * decision or a Tracked resolution is final on the first try, not something
 * that earns three strikes before it sticks.
 */
app.post("/api/items/:id/:action", async (req, res) => {
  const { id, action } = req.params;

  let updated;
  if (action === "dismiss") {
    updated = await dismissItem(id, { threshold: config.dismissal?.afterCount ?? 3, auto: false });
  } else if (action === "suppress") {
    updated = await suppressPermanently(id);
  } else if (action === "priority" || action === "not-priority") {
    updated = await triageItem(id, action);
  } else if (action === "wontdo" || action === "wrong") {
    updated = await resolveTrackedItem(id, { outcome: "dismissed", reason: action });
  } else if (action === "snooze") {
    // `until` (an explicit ISO date/time — what the Tasks page's own date
    // picker sends, see the plan's answer on this) takes priority over the
    // older `days` shortcut. See snoozeItem() in lib/store.js.
    updated = await snoozeItem(id, { until: req.body?.until || null, days: req.body?.days });
  } else {
    const map = {
      done: { status: "done", resolvedAt: new Date().toISOString() },
      // A clean slate: reopening should mean reopening, not "reopened but
      // still one strike away from being suppressed again for no reason."
      // Triage/resolution state resets too, for the same reason — a
      // reopened item lands back in the Inbox, undecided, rather than
      // stuck oddly still "Tracked" or still carrying an old wontdo/wrong.
      reopen: {
        status: "open", snoozeUntil: null, surfaceCount: 0,
        dismissStrikes: 0, permanentlySuppressed: false, autoDismissed: false,
        triage: null, resolutionReason: null, resolvedAt: null,
      },
    };
    const patch = map[action];
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

// Round 53 follow-up — Jon: "maybe I could adjust the pulse frequency,
// like, with a plus minus or a dropdown menu." Writes straight to
// config.json (round-trip parse/edit/write so every other key and every
// _note survives untouched) AND mutates the live `config` object's
// existing schedule sub-object in place — not a reassignment — so the
// already-running scheduler (which holds the same object reference from
// its own startScheduler(config) call at boot) picks it up too.
// lib/scheduler.js's tick() re-reads config.schedule.pullEveryMinutes
// fresh every 20s specifically so this takes effect within a tick or
// two, no restart required.
app.post("/api/config/pull-frequency", async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
    return res.status(400).json({ error: "minutes must be a whole number between 1 and 180" });
  }
  try {
    // A targeted text replace, not a JSON.parse-then-stringify round trip
    // — config.json is hand-formatted (compact arrays-of-objects, real
    // em-dashes, a "_note" convention throughout) and JSON.stringify has
    // no idea any of that matters. Re-serializing the whole file would
    // silently reformat every line the moment this button gets used
    // once, not just the one number that's actually changing.
    const text = await fs.readFile(CONFIG_PATH, "utf-8");
    const pattern = /("pullEveryMinutes"\s*:\s*)\d+/;
    if (!pattern.test(text)) {
      throw new Error('could not find "pullEveryMinutes" in config.json to update — edit it by hand instead');
    }
    await fs.writeFile(CONFIG_PATH, text.replace(pattern, `$1${minutes}`), "utf-8");

    config.schedule = config.schedule || {};
    config.schedule.pullEveryMinutes = minutes;

    log.info(`pull frequency changed to every ${minutes} min`);
    res.json({ ok: true, pullEveryMinutes: minutes });
  } catch (err) {
    log.error(`POST /api/config/pull-frequency failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Round 53 follow-up — Jon: "could I potentially have a restart button,
// which just does the deploy." Runs the real deploy.sh (git pull, deps,
// tests, frontend build, then `sudo systemctl restart pi-secretary` —
// see that script's own comments) as a child process, exactly what a
// manual `./deploy.sh` over SSH does.
//
// One real wrinkle: deploy.sh's own last step restarts THIS process. Once
// that happens, systemd tears down pi-secretary.service's whole cgroup —
// including this spawned child — so we lose the ability to observe a
// *successful* run finishing (its trailing `echo "done"` never gets to
// run). That's fine: by the time the restart line executes, deploy.sh has
// already done everything that matters (pull, install, test, build), so
// the deploy itself is not at risk — only this route's own visibility
// into the last few cosmetic lines is. A FAILED run (bad pull, failing
// tests, a broken build) exits before ever reaching the restart, so this
// process survives to see it and record the real exit code — see the
// 'close' handler below. The success case is instead reconciled at boot:
// if the app is starting up and finds a deploy still marked "running" in
// meta, that can only mean the restart it triggered actually happened —
// see reconcileDeployStatus() near the bottom of this file.
let deployChild = null;

app.post("/api/system/deploy", async (_req, res) => {
  if (deployChild) {
    return res.status(409).json({ error: "a deploy is already running" });
  }
  const startedAt = new Date().toISOString();
  await setMeta("deployStatus", { status: "running", startedAt, finishedAt: null, exitCode: null, tail: "" });

  const child = spawn("bash", ["deploy.sh"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  deployChild = child;
  log.info("deploy started via /api/system/deploy");

  let full = "";
  let tail = "";
  const onData = (chunk) => {
    const text = chunk.toString();
    full += text;
    tail = (full.length > 4000 ? full.slice(-4000) : full);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("close", async (code) => {
    deployChild = null;
    try {
      await fs.writeFile(DEPLOY_LOG_PATH, full, "utf-8");
    } catch (err) {
      log.warn(`could not write ${DEPLOY_LOG_PATH}: ${err.message}`);
    }
    // Only reached when deploy.sh exited on its own — see the comment
    // above the route for why a successful run doesn't get here.
    await setMeta("deployStatus", {
      status: code === 0 ? "succeeded" : "failed",
      startedAt, finishedAt: new Date().toISOString(), exitCode: code, tail,
    });
    log.info(`deploy finished with exit code ${code}`);
  });

  child.on("error", async (err) => {
    deployChild = null;
    log.error(`deploy failed to start: ${err.message}`);
    await setMeta("deployStatus", {
      status: "failed", startedAt, finishedAt: new Date().toISOString(), exitCode: null, tail: err.message,
    });
  });

  res.json({ ok: true, startedAt });
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

// Round 53 follow-up — see the big comment above POST /api/system/deploy
// for why a successful deploy can't mark itself "succeeded" (the restart
// it triggers kills the process doing the marking). If we're booting up
// and deployStatus still says "running", the only way that's possible is
// that the restart it kicked off is what's happening right now — so this
// is where that gets resolved, every boot, whether or not a deploy was
// actually involved this time (a totally normal restart just finds
// nothing to reconcile and does nothing).
async function reconcileDeployStatus() {
  const d = await getMeta("deployStatus", null);
  if (d && d.status === "running") {
    await setMeta("deployStatus", { ...d, status: "succeeded", finishedAt: new Date().toISOString() });
    log.info("boot: a deploy was still marked running — the fact we're booting means it succeeded, marking it resolved");
  }
}

(async () => {
  await loadConfig();
  await initStore();
  await reconcileDeployStatus();

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
