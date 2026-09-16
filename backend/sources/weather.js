// sources/weather.js
//
// Round 82. The Weather screen's real backend: current temp, today's high/
// low, and a short plain-language description, for the LED wall and the
// website's Weather page (round 86 — see claude/round-81-weather-mode-
// planning.md for the original plan and this round's follow-up).
//
// Two halves, the same split every other source in this app uses:
//
//   - Real numbers from Open-Meteo (https://open-meteo.com/en/docs) — no
//     API key, no account, no billing tier, 10,000 calls/day free. This was
//     already the pick in claude/integration-roadmap.md over OpenWeatherMap,
//     which paywalls the tier you'd actually want. Current temperature,
//     today's high/low, a WMO weather code, and hourly temperature/
//     precipitation-probability/weather-code arrays (the last covers both
//     the "when does rain hit today" precip window and, since round 86, the
//     hourly icon timeline — see buildHourlySlots below).
//   - A small set of RULES (never the model) turn those raw numbers into
//     the facts that actually matter: which of six icon buckets the
//     condition maps to (iconForWmoCode — the same six keys the HUB75 Twin's
//     weather chips already use: sun/partly_sunny/cloud/rain/snow/
//     lightning), whether precipitation is expected and roughly when
//     (buildPrecipWindow), and whether cold + precipitation means icy roads
//     are a real possibility (computeIcyRoadRisk). Every one of these is a
//     plain threshold, inspectable and unit-tested (scripts/test-weather.js)
//     without a network call — never a judgment call handed to DeepSeek.
//   - One DeepSeek sentence (lib/weatherTake.js) that reads those already-
//     decided facts and writes a short, pointed line. Round 82's brief was
//     purely descriptive ("hot day today, chance of rain this afternoon");
//     round 87 flipped that — Jon wants the one thing the screen's numbers
//     don't already say, never a recap of the high/low sitting right next
//     to it, so this file now also decides compareToYesterday (a fixed
//     °C-delta threshold, not a model guess) and peakHeatSlot (scanning
//     hourlySlots for the hottest hour), and fetches the day's remaining
//     timed events (buildTodaysEvents) so the summary can land a dry, real
//     one — "bring a sweater to your 5 PM game" — instead of a generic
//     one. See lib/weatherTake.js's own header for the prompt itself.
//     Degrades to buildFallbackSummary() below (a plain rule-built
//     sentence, no AI needed at all) if the model is off or the call
//     fails, so the screen is never blank just because an API key expired.
//
// Deliberately produces NO items, same reasoning sources/marketNews.js
// documents — "chance of rain" is not a thing you have to do. Writes one
// meta blob, `weather`, that server.js's /api/matrix route reads.
//
// A single source, unlike marketNews.js's several RSS feeds — so unlike
// that file, any fetch failure here is a genuine source error and is left
// to throw, same convention as sources/calendar.js or sources/money.js: a
// dead single source should show up as a real lastError_weather, not a
// silently empty screen.
//
// Location defaults to Ottawa (config.weather.latitude/longitude override
// it) since that's where the physical wall lives; units default to Celsius.

import axios from "axios";
import { logger } from "../lib/log.js";
import { getMeta, setMeta, allItems } from "../lib/store.js";
import { localDateKey } from "../lib/time.js";
import { getWeatherSummary } from "../lib/weatherTake.js";

const log = logger("weather");

export const DEFAULT_LATITUDE = 45.4215; // Ottawa, ON
export const DEFAULT_LONGITUDE = -75.6972;
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// ------------------------------------------------------------ pure rules

// WMO weather codes -> the six icon buckets prototyped in the HUB75 Twin.
// Deliberately coarse (a handful of very different WMO codes can share one
// bucket) — the wall only has room to draw six glyphs, not forty.
export function iconForWmoCode(code) {
  if (code === 0) return "sun";
  if (code === 1 || code === 2) return "partly_sunny";
  if (code === 3 || code === 45 || code === 48) return "cloud";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "lightning";
  return "cloud";
}

const CONDITION_LABELS = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "foggy",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "rain showers", 82: "heavy rain showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms", 99: "severe thunderstorms",
};

/** Human-readable label for a WMO code — separate from iconForWmoCode's
 *  coarse bucket, since the AI prompt (and, later, the website chip) can
 *  use finer detail than the six-icon wall can draw. */
export function conditionLabelForWmoCode(code) {
  return CONDITION_LABELS[code] || "mixed conditions";
}

function periodLabelForHour(hour) {
  if (hour < 6) return "overnight";
  if (hour < 12) return "this morning";
  if (hour < 17) return "this afternoon";
  if (hour < 21) return "this evening";
  return "overnight";
}

// Round 86 — the hourly timeline bar, prototyped in the HUB75 Twin
// (claude/hub75-twin.html, rounds 84-85) and now wired to real data. The
// Twin's fake `hourly` array was one icon bucket per hour across a fixed
// 6am-11pm window, matching the same day window the Events screen's own
// timeline already uses (minutesToFrac's dayStart=6*60, dayEnd=23*60) — 17
// one-hour columns, each column i covering [6+i, 7+i) o'clock, so the last
// column (i=16) covers 10pm-11pm. HOURLY_WINDOW_START_HOUR/END_HOUR below
// are that same window's endpoints (end inclusive, since it's "the hour
// this column starts at").
export const HOURLY_WINDOW_START_HOUR = 6;
export const HOURLY_WINDOW_END_HOUR = 22;

function formatHourLabel(hour) {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

/**
 * Buckets Open-Meteo's hourly arrays into one slot per hour across the
 * fixed display window, always the full window regardless of the current
 * time — same reasoning the Twin's fake data used a full-day array: the
 * wall and dashboard show the whole day's shape, not just what's left of
 * it. Pure and exported for the same no-network-call testing convention
 * as buildPrecipWindow. Returns [] (never throws) if hourly data wasn't
 * sent, so a slow/failed forecast degrades to "no timeline" rather than
 * breaking the rest of the facts object.
 */
export function buildHourlySlots(hourly, { startHour = HOURLY_WINDOW_START_HOUR, endHour = HOURLY_WINDOW_END_HOUR, dateKey = null } = {}) {
  if (!hourly?.time?.length) return [];
  const indexByHour = new Map();
  for (let i = 0; i < hourly.time.length; i++) {
    if (dateKey && dateOf(hourly.time[i]) !== dateKey) continue; // round 87: skip other days once past_days=1 mixes yesterday in
    indexByHour.set(hourOf(hourly.time[i]), i);
  }
  const slots = [];
  for (let hour = startHour; hour <= endHour; hour++) {
    const i = indexByHour.get(hour);
    if (i == null) continue; // Open-Meteo sends a full 24h day for forecast_days>=1, so this shouldn't happen in practice
    const tempC = hourly.temperature_2m?.[i] != null ? Math.round(hourly.temperature_2m[i]) : null;
    const pop = hourly.precipitation_probability?.[i] ?? null;
    slots.push({
      hour,
      hourLabel: formatHourLabel(hour),
      tempC,
      icon: iconForWmoCode(hourly.weather_code?.[i]),
      pop,
    });
  }
  return slots;
}

// Open-Meteo returns hourly.time as local wall-clock strings ("2026-09-15T14:00")
// once a timezone param is given — parsed directly rather than via `new
// Date()`, which would otherwise reinterpret an offset-less string in
// whatever timezone this process happens to be running in.
function hourOf(isoLocal) {
  return Number(isoLocal.slice(11, 13));
}

// Same "local wall-clock string, not a re-parsed Date" reasoning as hourOf,
// for the calendar-date half of an Open-Meteo local timestamp. Needed as of
// round 87's `past_days=1` fetch (see fetchForecast) — once yesterday's data
// shares the same hourly/daily arrays as today's, "hour 14" alone no longer
// picks out a single row, so buildHourlySlots/buildPrecipWindow narrow to a
// specific calendar day when one is given.
function dateOf(isoLocal) {
  return String(isoLocal).slice(0, 10);
}

/**
 * The single highest precipitation-probability hour remaining today (never
 * one that's already passed — no point describing "rain this morning" as
 * upcoming at 3pm), bucketed into a plain time-of-day label. Returns null
 * below `thresholdPercent`, so a 10% chance never gets dressed up as a real
 * callout. Pure and exported so this can be tested without a network call,
 * same convention as sources/marketNews.js's parseRssFeed/dedupeHeadlines.
 */
export function buildPrecipWindow(hourly, { fromHour = 0, thresholdPercent = 30, dateKey = null } = {}) {
  if (!hourly?.time?.length) return null;
  let best = null;
  for (let i = 0; i < hourly.time.length; i++) {
    if (dateKey && dateOf(hourly.time[i]) !== dateKey) continue; // round 87: skip other days once past_days=1 mixes yesterday in
    const hour = hourOf(hourly.time[i]);
    if (hour < fromHour) continue;
    const prob = hourly.precipitation_probability?.[i];
    if (prob == null) continue;
    if (!best || prob > best.prob) best = { prob, hour, code: hourly.weather_code?.[i] };
  }
  if (!best || best.prob < thresholdPercent) return null;
  const kind = iconForWmoCode(best.code) === "snow" ? "snow" : "rain";
  return { probabilityPercent: best.prob, periodLabel: periodLabelForHour(best.hour), kind };
}

/** Rule, not a model guess (same spirit as marketNews.js's bucketVix): cold
 *  enough to freeze, combined with precipitation either already falling
 *  (snow right now) or expected later today, is worth calling out. */
export function computeIcyRoadRisk({ lowC, precipWindow, conditionKey }) {
  if (lowC == null) return false;
  return lowC <= 1 && (precipWindow != null || conditionKey === "snow");
}

/** The single hottest hour left in today's hourlySlots — "peak heat around
 *  3 PM" — another decided fact (round 87) rather than something the AI
 *  prompt has to scan the hourly list itself to find. null if no slot has a
 *  temperature at all. */
export function peakHeatSlot(hourlySlots) {
  if (!hourlySlots?.length) return null;
  let best = null;
  for (const slot of hourlySlots) {
    if (slot.tempC == null) continue;
    if (!best || slot.tempC > best.tempC) best = slot;
  }
  return best ? { hourLabel: best.hourLabel, tempC: best.tempC } : null;
}

// Same "a rule decides, the AI only phrases it" split as computeIcyRoadRisk
// — round 87: Jon wants the summary to say things like "much colder than
// yesterday" rather than repeating the raw high/low he can already see, and
// letting a model eyeball a temperature delta itself risks it rounding
// differently each time or just getting the direction wrong. Fixed
// thresholds instead, in °C of today's high vs yesterday's.
export function compareToYesterday(highC, yesterdayHighC) {
  if (highC == null || yesterdayHighC == null) return null;
  const delta = highC - yesterdayHighC;
  if (delta >= 8) return "much warmer";
  if (delta >= 3) return "warmer";
  if (delta <= -8) return "much colder";
  if (delta <= -3) return "colder";
  return "about the same";
}

/** Turns one Open-Meteo forecast response into the facts every downstream
 *  consumer (the AI summary, the fallback sentence, /api/matrix) actually
 *  reads. Everything here is deterministic — no network, no AI. */
export function buildWeatherFacts(payload) {
  const cur = payload?.current || {};
  const daily = payload?.daily || {};
  const hourly = payload?.hourly || {};

  // Round 87: fetchForecast now sends past_days=1 so yesterday's high/low
  // is available for compareToYesterday below, which means daily's arrays
  // (and hourly's) may carry more than just today. dailyTodayIdx finds
  // which entry actually IS today — daily.time[i] is a bare "YYYY-MM-DD" —
  // rather than assuming index 0, which used to be true when the fetch was
  // today-only. Falls back to index 0 when daily.time isn't present at all
  // (old test fixtures, or a response shaped some other way), preserving
  // this function's pre-round-87 behavior exactly.
  const dailyTimes = daily.time || [];
  const todayKey = typeof cur.time === "string" ? dateOf(cur.time) : null;
  let dailyTodayIdx = 0;
  if (todayKey && dailyTimes.length) {
    const found = dailyTimes.indexOf(todayKey);
    dailyTodayIdx = found >= 0 ? found : dailyTimes.length - 1;
  }
  const dailyYesterdayIdx = dailyTodayIdx - 1;

  const code = cur.weather_code ?? daily.weather_code?.[dailyTodayIdx] ?? 3;
  const conditionKey = iconForWmoCode(code);
  const conditionLabel = conditionLabelForWmoCode(code);

  const currentTempC = cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null;
  const highC = daily.temperature_2m_max?.[dailyTodayIdx] != null ? Math.round(daily.temperature_2m_max[dailyTodayIdx]) : null;
  const lowC = daily.temperature_2m_min?.[dailyTodayIdx] != null ? Math.round(daily.temperature_2m_min[dailyTodayIdx]) : null;
  const yesterdayHighC =
    dailyYesterdayIdx >= 0 && daily.temperature_2m_max?.[dailyYesterdayIdx] != null
      ? Math.round(daily.temperature_2m_max[dailyYesterdayIdx])
      : null;
  const vsYesterday = compareToYesterday(highC, yesterdayHighC);

  const fromHour = typeof cur.time === "string" ? hourOf(cur.time) : 0;
  const precipWindow = buildPrecipWindow(hourly, { fromHour, dateKey: todayKey });
  const icyRoadRisk = computeIcyRoadRisk({ lowC, precipWindow, conditionKey });
  const hourlySlots = buildHourlySlots(hourly, { dateKey: todayKey });
  const peakHeat = peakHeatSlot(hourlySlots);

  return {
    conditionKey, conditionLabel, currentTempC, highC, lowC,
    yesterdayHighC, vsYesterday, peakHeat,
    precipWindow, icyRoadRisk, hourlySlots,
  };
}

/** No AI, no network — a plain rule-built sentence. Round 87: Jon wants the
 *  summary to add the one thing that isn't already visible elsewhere on the
 *  screen, not recap the high/low — so, unlike before round 87, this never
 *  mentions an exact temperature. Leads with the condition, then whichever
 *  of "compared to yesterday" / "when it peaks" is more interesting, then
 *  precipitation and icy roads. This is what the screen shows when DeepSeek
 *  is off, out of credit, or the call fails outright, so the Weather screen
 *  is never blank just because an API key expired. */
export function buildFallbackSummary(facts) {
  const parts = [];
  parts.push(`${facts.conditionLabel.charAt(0).toUpperCase()}${facts.conditionLabel.slice(1)} today.`);
  if (facts.precipWindow) {
    parts.push(
      `${facts.precipWindow.probabilityPercent}% chance of ${facts.precipWindow.kind} ${facts.precipWindow.periodLabel}.`
    );
  }
  if (facts.icyRoadRisk) parts.push("Icy roads possible.");
  if (facts.vsYesterday && facts.vsYesterday !== "about the same") {
    parts.push(`${facts.vsYesterday.charAt(0).toUpperCase()}${facts.vsYesterday.slice(1)} than yesterday.`);
  } else if (facts.peakHeat) {
    parts.push(`Peak heat around ${facts.peakHeat.hourLabel}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------- network

async function fetchForecast(cfg, tz) {
  const params = {
    latitude: cfg.latitude ?? DEFAULT_LATITUDE,
    longitude: cfg.longitude ?? DEFAULT_LONGITUDE,
    current: "temperature_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    timezone: tz,
    forecast_days: 1,
    // Round 87 — one extra day BACKWARD (yesterday), on top of the one day
    // forward forecast_days already asks for, so buildWeatherFacts can
    // compute compareToYesterday. daily/hourly both grow by this same one
    // day, which is exactly why buildWeatherFacts now looks up "today"'s
    // index by date instead of assuming it's index 0.
    past_days: 1,
    temperature_unit: cfg.units === "fahrenheit" ? "fahrenheit" : "celsius",
  };
  const res = await axios.get(FORECAST_URL, { params, timeout: cfg.timeoutMs ?? 8000 });
  return res.data;
}

// ------------------------------------------------------------------- main

// Round 87 — today's still-upcoming timed events, for the AI summary's
// "bring a sweater to your 5 PM game" line. Deliberately narrow: only
// today, only calendar-sourced, only still ahead of now, only timed (an
// all-day event has no clock moment to hang a joke on), capped at a
// handful so the prompt stays short. Reads straight from the store rather
// than depending on sources/calendar.js directly — by the time "weather"
// runs in lib/sources.js's SOURCES list, calendar has already run in the
// same pass and its items are already there to read.
export function buildTodaysEvents(items, { tz = "America/Toronto", now = new Date(), max = 5 } = {}) {
  const todayKey = localDateKey(now, tz);
  return (items || [])
    .filter((i) => i.source === "calendar" && i.dueAt && i.kind !== "system" && !i.meta?.allDay)
    .filter((i) => new Date(i.dueAt) >= now)
    .filter((i) => localDateKey(new Date(i.dueAt), tz) === todayKey)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .slice(0, max)
    .map((i) => ({
      title: i.title,
      time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(i.dueAt)),
    }));
}

export async function collectWeather(config, { force = false } = {}) {
  const cfg = config.weather || {};
  const tz = config.timezone || "America/Toronto";

  const payload = await fetchForecast(cfg, tz);
  const facts = buildWeatherFacts(payload);
  const todaysEvents = buildTodaysEvents(await allItems(), { tz, now: new Date() });

  const previous = await getMeta("weather", null);
  const take = await getWeatherSummary(config, facts, { previous, force, todaysEvents });
  const summary = take.text || previous?.summary || buildFallbackSummary(facts);
  const summaryAt = take.text ? take.at : previous?.summary ? previous.summaryAt : new Date().toISOString();

  await setMeta("weather", { ...facts, summary, summaryAt, at: new Date().toISOString() });

  log.info(
    `${facts.currentTempC}°C now, ${facts.lowC}-${facts.highC}°C (${facts.conditionLabel}) -> "${summary}"`
  );

  return [];
}
