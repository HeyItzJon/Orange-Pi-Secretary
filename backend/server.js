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
import { init as initStore, getMeta, setMeta, getItem, patchItem, dismissItem, suppressPermanently, triageItem, resolveTrackedItem, snoozeItem, allItems, portfolioHistory, recordLocationPing, recordAlarmPost } from "./lib/store.js";
import { startScheduler } from "./lib/scheduler.js";
import { runSources, buildBrief, SOURCE_NAMES } from "./brief/compose.js";
import { buildDisplay, shortTicker, weekForecast, filterLive, isTaskLike } from "./brief/display.js";
import { buildItemDetail } from "./brief/detail.js";
import { getTickerDetail } from "./lib/stockIdeaDetail.js";
import {
  setEnabledScreens, setPinnedScreen, pushScreen, clearPushedScreen,
  pushNotification, clearNotification, pushAlert, clearAlert,
  fireTestEvent, commandPayload, statusPayload, MatrixControlError,
} from "./lib/matrixControl.js";
import { collectSystemHealth, evaluateProblems } from "./lib/systemHealth.js";
import { isMarketLive } from "./sources/money.js";
import { shortDescFallback } from "./lib/eventDigest.js";
import { buildAskContext, buildAskPrompt } from "./brief/ask.js";
import { ask } from "./lib/ai.js";
import { computeAlternativesForLeg } from "./lib/commute.js";

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
// "FRI 4:00PM" — compact day+time for the wall's stale-price label
// (round 74). Includes the weekday since "last known price" over a
// weekend or holiday is not today's time, and a bare hour would look
// like it just refreshed instead of being the actual last trade.
// Round 77 — see the comment above this function's one call site in
// /api/matrix for the full story on why this exists.
function sanitizeForWall(text) {
  if (!text) return text;
  return String(text)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")   // curly/typographic single quotes, prime
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')   // curly/typographic double quotes
    .replace(/[\u2013\u2014]/g, "-")                 // en/em dash
    .replace(/\u2026/g, "...")                        // ellipsis
    .replace(/[\u00A0\u2000-\u200B]/g, " ")          // non-breaking/odd-width spaces
    .replace(/[^\x20-\x7E]/g, "");                    // anything else non-ASCII — dropped, not boxed
}

function formatLastPriceLabel(iso, tz) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekday = get("weekday").toUpperCase();
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod").toUpperCase();
  if (!weekday || !hour || !minute || !dayPeriod) return null;
  return `${weekday} ${hour}:${minute}${dayPeriod}`;
}

app.get("/api/matrix", async (_req, res) => {
  try {
    const now = new Date();
    const [items, money, marketPulse, brief, eventDigest, weatherMeta, commute, commutePlan, sleepMeta] = await Promise.all([
      allItems(),
      getMeta("moneySummary", null),
      getMeta("marketPulse", null),
      getMeta("lastBrief", null),
      getMeta("eventDigest", null),
      getMeta("weather", null),
      getMeta("commute", null),
      getMeta("commutePlan", null),
      getMeta("sleep", null),
    ]);
    const eventDigestMap = eventDigest?.map || {};

    // Portfolio: total value, day change ($), day change (%)
    const portfolio = money
      ? {
          total: Math.round((money.total || 0) * 100) / 100,
          dayChange: Math.round((money.dayChangeValue || 0) * 100) / 100,
          dayChangePercent: Math.round((money.dayPct || 0) * 100) / 100,
        }
      : null;

    // Market indices (S&P 500 / Nasdaq / TSX / Dow / Russell 2000) — from
    // marketPulse, refreshed by sources/marketNews.js on the same
    // 15-minute cycle. No fetch here. This was always built and sent;
    // round 74 is just the first time the firmware has a real Markets
    // screen to read it instead of the renderComingSoonFwd placeholder.
    const shortLabel = (label) => (label === "S&P 500" ? "S&P" : label.toUpperCase());
    const markets = (marketPulse?.indices || [])
      .filter((i) => i.pct != null)
      .map((i) => ({
        symbol: shortLabel(i.label),
        changePercent: Math.round(i.pct * 100) / 100,
      }));

    // VIX — same marketPulse blob, not previously surfaced on this route.
    // Sent separately from markets[] (round 74) so the wall can color it
    // by its own calm/normal/jumpy/volatile bucket instead of a % change —
    // VIX doesn't have a directional "up is good" reading the way an
    // index does.
    const vix = marketPulse?.vix
      ? { value: Math.round(marketPulse.vix.value * 10) / 10, bucket: marketPulse.vix.bucket }
      : null;

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

    // Round 76 — Jon: "the all day events are still showing up at the
    // beginning of the timeline... I do not want [them] at the beginning
    // of the timeline. I need you to make a new separate page... with the
    // all day events separately... they can scroll." All-day events have
    // no real clock time (clockTime/dueAt's time portion is meaningless
    // for them), so they always sorted first by the .localeCompare below
    // and ate a full-width timeline sliver at hour 0 — that's the "beginning
    // of the timeline" bug. Fix: split them out entirely. `events` is now
    // timed-only (feeds the timeline bar + per-event caption cycle exactly
    // like before); `allDayEvents` is a new, separate list — title + cal
    // only, there's nothing timeline-shaped about an all-day event — for
    // the firmware's own dedicated all-day page.
    const todayCalendarItems = items.filter(
      (i) => i.source === "calendar" && i.dueAt?.startsWith(today) && i.status === "open"
    );

    const todayEvents = todayCalendarItems
      .filter((e) => !e.meta?.allDay)
      .map((e) => {
        // dur: real end-minus-start minutes when we know the end time,
        // clamped to a sane 5-600min range so a bad/missing end time can't
        // paint a degenerate or day-spanning bar. desc: the same concise
        // note/time/location/attendee one-liner already built for the
        // Tasks/Day list rows (e.detail from sources/calendar.js),
        // truncated to fit the wall's second scrolling line. cal: the real
        // calendar bucket, already computed at ingestion (sources/
        // calendar.js's calendarSwatch() call) — round 72, closes the
        // round-62 gap (wrong/fallback event colors on the wall).
        const dur = e.meta?.end
          ? Math.min(600, Math.max(5, Math.round((new Date(e.meta.end) - new Date(e.dueAt)) / 60000)))
          : 30;
        // Round 77 — Jon: "the description... is wrapping onto a third
        // line... we don't have three lines... we don't need the location
        // necessarily, only important notes." desc used to be the raw
        // joined detail string (note · duration · location · attendees)
        // truncated at 60 chars — plenty long enough to overrun the single
        // scrolling line this screen actually has room for. Now it's the
        // DeepSeek-compressed one-liner (lib/eventDigest.js, refreshed
        // every scheduler tick, same pattern as the News screen's digest),
        // falling back to just the detail string's first "·" segment
        // (almost always the personal note, never the location) whenever
        // there's no cached digest entry yet for this event.
        const desc = eventDigestMap[e.id] ?? shortDescFallback(e.detail);
        return {
          // id: the raw item id, added this round so the commute page (and
          // anything else that needs to point at a specific row) can match
          // dayOverview.commuteEventId back to the actual event it's for,
          // instead of assuming "commuteMin is always for the next event" —
          // it isn't, when a closer event has no location (see commute.js's
          // header comment: commuteMin is computed for the next event WITH
          // A LOCATION, which can be later in the list than the very next
          // event). Existing firmware ignores fields it doesn't know about.
          id: e.id,
          time: e.clockTime || e.dueAt?.slice(11, 16) || "",
          title: sanitizeForWall((e.title || "").slice(0, 30)), // truncate for display
          busyLevel: e.meta?.busyLevel || "medium", // "busy" | "medium" | "light"
          cal: e.swatch || "",
          dur,
          desc: sanitizeForWall(desc),
          // location: the event's raw Google Calendar location, untouched —
          // NOT for display (round 77 already stripped it out of `desc` for
          // exactly that reason). This is for the commute/ETA feature
          // (claude/commute-eta-plan.md) to read: a null here means "no
          // location on this event," which the commute job treats as
          // unresolved rather than guessing. Existing firmware just ignores
          // an extra field it doesn't know about, same as every other
          // additive contract change in this project.
          location: e.meta?.location || null,
        };
      })
      .sort((a, b) => a.time.localeCompare(b.time));

    const allDayEvents = todayCalendarItems
      .filter((e) => e.meta?.allDay)
      .map((e) => ({
        title: sanitizeForWall((e.title || "").slice(0, 40)),
        cal: e.swatch || "",
      }));

    // Day Overview's hoursBusy/hoursFree — round 72, closes the round-64
    // punch-list gap. Same weekForecast() math the Week page already uses
    // (see brief/display.js's buildDayContext for the identical filterLive
    // -> calendar-only -> weekForecast pattern), just asked for a single
    // day (today) instead of the 7-day window.
    const liveItems = filterLive(items, now);
    const calendarEvents = liveItems
      .filter((i) => i.source === "calendar" && i.dueAt && i.kind !== "system")
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const todayForecast = weekForecast(calendarEvents, liveItems.filter(isTaskLike), {
      now,
      tz: config.timezone,
      days: 1,
    }).days[0];
    const dayOverview = {
      hoursBusy: todayForecast?.busyHours ?? 0,
      // commuteMin — real ETA source as of this round (lib/commute.js,
      // refreshed once per scheduler tick, never computed here). Only
      // included when there's a real number cached for TODAY specifically
      // — a stale entry from yesterday (server restarted overnight before
      // the next tick ran, say) must never leak through as if it were
      // current. The firmware's own dov.containsKey("commuteMin") check
      // is what gates the Commuting screen off the fallback card, so
      // omitting the key entirely (not sending null/0) is what keeps that
      // "never fabricate" contract intact end to end.
      // commuteEventId/commuteLabel/commuteRoute ride along with commuteMin
      // for the same reason `id` was just added to todayEvents above: the
      // event commuteMin applies to is "the next event with a resolved
      // location," not necessarily events[0] in the list, so the dashboard
      // page needs the id to attach "LEAVE BY" to the right row instead of
      // guessing it's always the first one. label/route are the same
      // human-readable strings refresh-commute.js already prints.
      // commuteTargetAt (round 92 follow-up) — the leg's own raw target
      // timestamp, so the dashboard can compute "leave by" directly instead
      // of re-deriving it from a matching todayEvents row's formatted time
      // string. Needed now that "next" can be lib/commute.js's synthetic
      // end-of-day "drive home" leg, which has no todayEvents entry at all.
      ...(commute?.day === today
        ? {
            commuteMin: commute.minutes,
            commuteEventId: commute.eventId,
            commuteLabel: commute.label,
            commuteRoute: commute.route,
            commuteTargetAt: commute.targetAt,
          }
        : {}),
      hoursFree: todayForecast?.freeHours ?? 0,
    };

    // Daily busy score (0-100) — round 75 fix — Jon: "the busy score on
    // the LED panel is not updating. It still says zero, whereas the
    // website says four." Was reading brief.insights.busyPercent, a field
    // refreshInsights() never produces (dead code, always 0). The website
    // itself displays todayForecast.busyness directly as "Busy Score N/10"
    // (Display.jsx) -- reuse that same value here, computed above, and
    // scale x10 since the firmware unscales this field by /10 to get its
    // own 0-10 score.
    const dailyBusyPercent = Math.round((todayForecast?.busyness ?? 0) * 10);
    log.info(
      `busy score: busyness=${todayForecast?.busyness ?? "null"}/10 ` +
      `busyHours=${todayForecast?.busyHours ?? "null"} freeHours=${todayForecast?.freeHours ?? "null"} ` +
      `events=${todayForecast?.eventCount ?? "null"} -> dailyBusyPercent=${dailyBusyPercent}`
    );

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
    // Round 74: prefers the 3 DeepSeek-compressed headlines
    // (lib/newsDigest.js, computed once per marketNews pull and cached by
    // content hash — not on every /api/matrix poll), falling back to the
    // 3 newest raw headlines, FULL LENGTH, if the digest hasn't produced
    // anything yet. The old `.slice(0, 60)` truncation is gone — combined
    // with the firmware joining every headline with " / " into one scroll
    // string, that's what was cutting titles off mid-word (Jon: "make
    // sure the full titles are there").
    const news = (
      marketPulse?.newsDigest?.length
        ? marketPulse.newsDigest
        : (marketPulse?.headlines || []).slice(0, 3).map((h) => ({ title: h.title || "", source: h.source || null }))
    ).map((h) => ({ title: sanitizeForWall(h.title), source: h.source ? sanitizeForWall(h.source) : null }));

    // Round 90 — Jon: pre/post-market (~4am-8pm ET combined) made the wall
    // read "open" almost all day under the old `!= null` gate, so the LIVE
    // dot and CLOSED banner basically never fired. isMarketLive() (see
    // sources/money.js) is the strict two-state answer: true only when a
    // regular session is actually trading right now, false for pre-market,
    // post-market, and true weekends/holidays alike. The money page still
    // shows the nuanced pre/post-market label separately — this is just
    // for the wall's plain yes/no LIVE-or-CLOSED question.
    const marketOpen = isMarketLive(money?.marketStatus);

    // Round 74 — Jon: "so we know that these prices... are not current,
    // and they are the last known price." quotedAt is each position's
    // real last-trade timestamp from Yahoo (sources/money.js's
    // regularMarketTime), frozen at whatever it was when the market
    // actually stopped trading — NOT this poll's own `at` timestamp,
    // which would just read as "recent" even hours or days into a closed
    // market. Only computed/sent when not live; the weekday is included
    // since "last known" over a weekend, holiday, or pre/post-market
    // session isn't necessarily today's regular-session close (round 90 —
    // marketOpen now also goes false during pre/post-market, so this label
    // shows then too, which is the honest thing to say: a pre-market quote
    // is still yesterday's close, not a live price).
    const lastQuotedAt = (money?.positions || [])
      .map((p) => p.quotedAt)
      .filter(Boolean)
      .sort()
      .pop();
    const lastPriceLabel =
      !marketOpen && lastQuotedAt ? formatLastPriceLabel(lastQuotedAt, config.timezone) : null;

    // Weather — round 82. sources/weather.js (Open-Meteo, no API key)
    // refreshes this on the same 15-minute source clock as everything else;
    // by the time this route reads it, every fact is already decided —
    // `icon` is one of the six buckets iconForWmoCode() maps every WMO code
    // to (the same six keys the HUB75 Twin's weather chips use), and
    // `summary` is either DeepSeek's plain description or, if the model is
    // off/unavailable, sources/weather.js's own rule-built fallback
    // sentence — this route never has to know which. Sent as null wholesale
    // rather than a block of zeros if the source hasn't produced anything
    // yet (fresh install, first pull still pending), so the firmware/wall
    // doesn't mistake "no data yet" for a real 0°C reading.
    //
    // `hourly` — round 86. One icon-bucket string per hour across the fixed
    // 6am-11pm window (sources/weather.js's buildHourlySlots, 17 entries),
    // deliberately flattened to just the icon here (not the richer
    // {hourLabel, tempC, icon, pop} shape buildHourlySlots produces) —
    // this is the same "flat JSON, short field names" convention the wall
    // endpoint has followed since its original design doc, and both the
    // ESP32 firmware's hourly timeline bar and the website's Weather page
    // only ever draw the icon per hour, so there's nothing else to send
    // here. Omitted (undefined) rather than [] when there's no weather
    // data yet at all, same reasoning as the `weather: null` case below.
    const weather = weatherMeta
      ? {
          tempC: weatherMeta.currentTempC,
          highC: weatherMeta.highC,
          lowC: weatherMeta.lowC,
          icon: weatherMeta.conditionKey, // sun | partly_sunny | cloud | rain | snow | lightning
          summary: sanitizeForWall(weatherMeta.summary || ""),
          hourly: (weatherMeta.hourlySlots || []).map((slot) => slot.icon),
          updatedAt: weatherMeta.at, // round 86 — the website's Weather page shows "updated Xm ago"; the firmware ignores this field
        }
      : null;

    res.json({
      timestamp: now.getTime(),
      lastRefresh: money?.at || null,
      portfolio,
      markets, // S&P, NASDAQ, TSX, DOW, RUSSELL with % change
      vix, // { value, bucket } or null — round 74
      gainers, // Top 3 holdings up today
      losers, // Top 3 holdings down today
      events: todayEvents,
      allDayEvents, // round 76 — separate all-day list, see comment above
      dailyBusyPercent,
      dayOverview,
      // commutePlan — round 92's full-day commute page: every leg between
      // today's located events (see lib/commute.js's refreshCommute), plus
      // daily totals (time/km/gas) and the DeepSeek insight line
      // (lib/commuteTake.js). Only sent for TODAY specifically, same
      // never-leak-yesterday's-cache rule dayOverview's commuteMin follows
      // above — the frontend's CommutePage treats a missing/stale plan as
      // "nothing computed yet," never as an empty day.
      commutePlan: commutePlan?.day === today ? commutePlan : null,
      // commuteStats — round 92, purpose-built for the LED wall's new
      // Commute Stats screen (matrixControl.js). Deliberately NOT just
      // commutePlan again: the ESP32's JSON doc has a fixed byte budget
      // (11264 in esp32-led-wall.ino) and the wall only ever needs a
      // handful of scalars, never the full legs[] array (which grows with
      // the day's event count and is already served to the dashboard
      // above) — same "small state blob" discipline the weather block
      // already follows here. No fuelCostCAD in this block at all, per
      // Jon: "top stats minus the money spend" — not just left off the
      // renderer, never sent to the wall to begin with.
      commuteStats:
        commutePlan?.day === today
          ? {
              totalDriveMinutes: commutePlan.totalDriveMinutes,
              totalKm: commutePlan.totalKm,
              rushLegCount: commutePlan.rushLegCount ?? 0,
              bothRushHit: !!commutePlan.bothRushHit,
              heavyDriveDay: !!commutePlan.heavyDriveDay,
              insight: commutePlan.insight || null,
            }
          : null,
      // sleep — round 92, the Sleep & Alarm screen's first real source
      // (matrixControl.js's SCREENS: hasData now true — see that file's own
      // comment). Written by POST /api/sleep-alarm (an iOS Shortcut, run
      // separately from and independently toggleable from the location
      // one). Gated to "posted within the last 20 hours" rather than
      // per-calendar-day like commutePlan — a bedtime automation running
      // nightly should always look current, but if the Shortcut gets
      // turned off, this needs to fall back to the firmware's own
      // "coming soon" card again, same as weather/markets going stale would
      // in spirit, rather than showing a week-old bedtime forever.
      sleep:
        sleepMeta?.updatedAt && Date.now() - new Date(sleepMeta.updatedAt).getTime() < 20 * 60 * 60 * 1000
          ? { bedTime: sleepMeta.bedTime, wakeTime: sleepMeta.wakeTime, nextAlarm: sleepMeta.nextAlarm || sleepMeta.wakeTime }
          : null,
      holdings,
      news,
      weather, // round 82 — see comment above
      marketOpen,
      lastPriceLabel, // e.g. "FRI 4:00PM" — only set when marketOpen is false (round 74)
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

// Round 75 — the "push" half of "push a page or pin a page depending":
// jump to a screen right now for a short, bounded window without
// disturbing whatever pin/rotation state was already active. See
// matrixControl.js's pushScreen() for the full design comment.
app.post("/api/matrix/push", async (req, res) => {
  try {
    res.json(await pushScreen(req.body?.screen, req.body?.durationSeconds));
  } catch (err) {
    if (err instanceof MatrixControlError) return res.status(400).json({ error: err.message });
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/push/clear", async (req, res) => {
  try {
    res.json(await clearPushedScreen());
  } catch (err) {
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

// Round 75 — Jon: "the alert... everything that we have in the LED panel
// code should be controllable from the website." The firmware has fully
// implemented alert rendering (renderAlert(), severity levels, the
// hazard-stripe border) since before this round; matrixControl.js's
// pushAlert()/clearAlert() are what finally send it.
app.post("/api/matrix/alert", async (req, res) => {
  try {
    res.json(await pushAlert(req.body?.text, req.body?.severity, req.body?.durationSeconds));
  } catch (err) {
    if (err instanceof MatrixControlError) return res.status(400).json({ error: err.message });
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/alert/clear", async (req, res) => {
  try {
    res.json(await clearAlert());
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
    // Commute is just another entry in runSources' own COLLECTORS map now
    // (brief/compose.js's collectCommute) — pressing the header's refresh
    // button re-runs it along with everything else, so a real drive time
    // shows up immediately after adding/moving a calendar event instead of
    // waiting for the scheduler's own 15-minute tick.
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
 * Round 92 — the rush-hour "alternatives" button next to a flagged drive
 * leg on the Commute page. Deliberately its own on-demand endpoint rather
 * than baked into the regular commutePlan/refresh cycle: each alternative
 * needs its own live Google Routes call (Jon's own call: "call the live
 * API" over a free estimate), and most rush legs will never actually get
 * clicked, so paying that cost on every ~15-minute refresh tick for every
 * rush leg in the day — most of which nobody looks at — would be pure
 * waste. lib/commute.js's computeAlternativesForLeg() has the full
 * eligibility rules (own comment there); this route is a thin pass-through
 * so a routing failure or "not eligible" reads as a normal 200 with
 * eligible:false (an expected, common outcome — most legs aren't rush,
 * most rush legs won't have a real gap), not a 4xx/5xx for something that
 * isn't actually an error.
 */
app.post("/api/commute/alternatives", async (req, res) => {
  const legKey = req.body?.legKey;
  if (!legKey || typeof legKey !== "string") {
    return res.status(400).json({ error: "legKey required" });
  }
  try {
    const result = await computeAlternativesForLeg(config, legKey);
    res.json(result);
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Round 92 — two iOS Shortcuts post here, per Jon: "post or push a json
 * with both my location and my alarm schedule straight from my iphone...
 * these would be separate shortcuts that I can always turn on and off when
 * I want." Two separate endpoints (not one with a `type` field) so each
 * Shortcut really can be toggled independently, matching that ask exactly.
 *
 * Every other endpoint in this file is either read-only or a click a
 * person just made on the dashboard itself — these two are the only
 * WRITE endpoints meant to be hit by an unattended automation, running
 * from outside any browser someone's actually looking at, so they're the
 * only ones gated by a shared secret (checkShortcutSecret below) rather
 * than relying purely on "you're on the tailnet" like the rest of this
 * app does today. Run `npm run set-shortcuts-secret` once to generate it;
 * the same value goes in both Shortcuts' request headers.
 */
function checkShortcutSecret(req, res) {
  const expected = process.env.SHORTCUTS_SECRET;
  if (!expected) {
    res.status(503).json({ error: "SHORTCUTS_SECRET not set on the server yet — run `npm run set-shortcuts-secret`" });
    return false;
  }
  if (req.headers["x-shortcut-secret"] !== expected) {
    res.status(401).json({ error: "missing or invalid X-Shortcut-Secret header" });
    return false;
  }
  return true;
}

// Round 92 follow-up — Jon: "I want my system to be 100% location aware
// and suggesting the best things all the time... lowkey for the last year
// or something so we can find patterns." So this now does two things on
// every post: keeps meta.lastLocation as the fast "where are you right
// now" read (still no day-gating on read — a live location is either
// fresh enough to trust or it isn't, regardless of what day it landed;
// consumers should treat anything more than ~20-30 min old as stale, per
// claude/commute-eta-plan.md's original design note), AND appends a row to
// location_history (lib/store.js) that is never overwritten — the actual
// year-long log the pattern-finding will eventually read from. Retention
// is config.shortcuts.locationHistoryMaxAgeDays (default 400 days), pruned
// daily alongside everything else store.js prunes.
//
// Nothing downstream reads location_history yet — no pattern-finding, no
// "suggest the best things" logic exists in this codebase today. This
// endpoint is the data foundation that has to exist before any of that can
// be built; the suggestion engine itself is a separate, much bigger ask
// (what signals, what suggestions, shown where) that hasn't been scoped.
app.post("/api/location", async (req, res) => {
  if (!checkShortcutSecret(req, res)) return;
  const { lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat/lng must be numbers" });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat/lng out of range" });
  }
  const capturedAt = typeof req.body?.capturedAt === "string" ? req.body.capturedAt : new Date().toISOString();
  const receivedAt = new Date().toISOString();
  await setMeta("lastLocation", { lat, lng, capturedAt, receivedAt });
  await recordLocationPing({ lat, lng, capturedAt, receivedAt });
  res.json({ ok: true });
});

// Writes the `sleep` meta blob /api/matrix's own `sleep` block reads
// (staleness-gated there to ~20 hours, so turning this Shortcut off makes
// the wall's Sleep & Alarm screen fall back to "coming soon" again rather
// than showing a stale bedtime forever — see that comment in /api/matrix),
// AND — round 92 follow-up, same "find patterns" ask as location above —
// appends a row to alarm_log (lib/store.js) that's never overwritten, so a
// year of bedtime/wake history builds up alongside the LED wall's own
// always-latest read. Retention is config.shortcuts.alarmHistoryMaxAgeDays
// (default 400 days), pruned daily alongside everything else store.js
// prunes.
app.post("/api/alarm", async (req, res) => {
  if (!checkShortcutSecret(req, res)) return;
  const { bedTime, wakeTime, nextAlarm } = req.body || {};
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!HHMM.test(bedTime || "") || !HHMM.test(wakeTime || "")) {
    return res.status(400).json({ error: "bedTime/wakeTime must be HH:MM, 24-hour" });
  }
  if (nextAlarm != null && !HHMM.test(nextAlarm)) {
    return res.status(400).json({ error: "nextAlarm must be HH:MM, 24-hour, if provided" });
  }
  const postedAt = new Date().toISOString();
  await setMeta("sleep", { bedTime, wakeTime, nextAlarm: nextAlarm || wakeTime, updatedAt: postedAt });
  await recordAlarmPost({ bedTime, wakeTime, nextAlarm: nextAlarm || null, postedAt });
  res.json({ ok: true });
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
