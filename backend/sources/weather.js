// sources/weather.js
//
// Round 82. The Weather screen's real backend: current temp, today's high/
// low, and a short plain-language description, for the LED wall (and later
// a small chip on the website's Today page — see round 81's planning doc,
// claude/round-81-weather-mode-planning.md, and this round's follow-up).
//
// Two halves, the same split every other source in this app uses:
//
//   - Real numbers from Open-Meteo (https://open-meteo.com/en/docs) — no
//     API key, no account, no billing tier, 10,000 calls/day free. This was
//     already the pick in claude/integration-roadmap.md over OpenWeatherMap,
//     which paywalls the tier you'd actually want. Current temperature,
//     today's high/low, a WMO weather code, and hourly precipitation
//     probability for the rest of the day.
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
//     decided facts and writes a concise, PURELY DESCRIPTIVE line — "hot day
//     today, chance of rain this afternoon," not "you should bring an
//     umbrella." Jon was explicit this round that this stays simple and
//     descriptive, not actionable — see that file's own header. Degrades to
//     buildFallbackSummary() below (a plain rule-built sentence, no AI
//     needed at all) if the model is off or the call fails, so the screen
//     is never blank just because an API key expired.
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
import { getMeta, setMeta } from "../lib/store.js";
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

// Open-Meteo returns hourly.time as local wall-clock strings ("2026-09-15T14:00")
// once a timezone param is given — parsed directly rather than via `new
// Date()`, which would otherwise reinterpret an offset-less string in
// whatever timezone this process happens to be running in.
function hourOf(isoLocal) {
  return Number(isoLocal.slice(11, 13));
}

/**
 * The single highest precipitation-probability hour remaining today (never
 * one that's already passed — no point describing "rain this morning" as
 * upcoming at 3pm), bucketed into a plain time-of-day label. Returns null
 * below `thresholdPercent`, so a 10% chance never gets dressed up as a real
 * callout. Pure and exported so this can be tested without a network call,
 * same convention as sources/marketNews.js's parseRssFeed/dedupeHeadlines.
 */
export function buildPrecipWindow(hourly, { fromHour = 0, thresholdPercent = 30 } = {}) {
  if (!hourly?.time?.length) return null;
  let best = null;
  for (let i = 0; i < hourly.time.length; i++) {
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

/** Turns one Open-Meteo forecast response into the facts every downstream
 *  consumer (the AI summary, the fallback sentence, /api/matrix) actually
 *  reads. Everything here is deterministic — no network, no AI. */
export function buildWeatherFacts(payload) {
  const cur = payload?.current || {};
  const daily = payload?.daily || {};
  const hourly = payload?.hourly || {};

  const code = cur.weather_code ?? daily.weather_code?.[0] ?? 3;
  const conditionKey = iconForWmoCode(code);
  const conditionLabel = conditionLabelForWmoCode(code);

  const currentTempC = cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null;
  const highC = daily.temperature_2m_max?.[0] != null ? Math.round(daily.temperature_2m_max[0]) : null;
  const lowC = daily.temperature_2m_min?.[0] != null ? Math.round(daily.temperature_2m_min[0]) : null;

  const fromHour = typeof cur.time === "string" ? hourOf(cur.time) : 0;
  const precipWindow = buildPrecipWindow(hourly, { fromHour });
  const icyRoadRisk = computeIcyRoadRisk({ lowC, precipWindow, conditionKey });

  return { conditionKey, conditionLabel, currentTempC, highC, lowC, precipWindow, icyRoadRisk };
}

const TEMP_WORDS = [
  [28, "hot"], [20, "warm"], [10, "mild"], [0, "cool"], [-10, "cold"],
];

function wordForHigh(highC) {
  if (highC == null) return null;
  for (const [min, word] of TEMP_WORDS) if (highC >= min) return word;
  return "very cold";
}

/** No AI, no network — a plain rule-built sentence in the same register
 *  Jon asked for ("hot day today, potential rain this afternoon... super
 *  cold, no snow, expect icy roads"). This is what the screen shows when
 *  DeepSeek is off, out of credit, or the call fails outright, so the
 *  Weather screen is never blank just because an API key expired. */
export function buildFallbackSummary(facts) {
  const parts = [];
  const word = wordForHigh(facts.highC);
  parts.push(
    word && facts.highC != null
      ? `A ${word} day, high of ${facts.highC}°C.`
      : `${facts.conditionLabel.charAt(0).toUpperCase()}${facts.conditionLabel.slice(1)} today.`
  );
  if (facts.precipWindow) {
    parts.push(
      `${facts.precipWindow.probabilityPercent}% chance of ${facts.precipWindow.kind} ${facts.precipWindow.periodLabel}.`
    );
  } else if (facts.conditionKey === "sun") {
    parts.push("Clear skies.");
  }
  if (facts.icyRoadRisk) parts.push("Icy roads possible.");
  return parts.join(" ");
}

// ---------------------------------------------------------------- network

async function fetchForecast(cfg, tz) {
  const params = {
    latitude: cfg.latitude ?? DEFAULT_LATITUDE,
    longitude: cfg.longitude ?? DEFAULT_LONGITUDE,
    current: "temperature_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    hourly: "precipitation_probability,weather_code",
    timezone: tz,
    forecast_days: 1,
    temperature_unit: cfg.units === "fahrenheit" ? "fahrenheit" : "celsius",
  };
  const res = await axios.get(FORECAST_URL, { params, timeout: cfg.timeoutMs ?? 8000 });
  return res.data;
}

// ------------------------------------------------------------------- main

export async function collectWeather(config, { force = false } = {}) {
  const cfg = config.weather || {};
  const tz = config.timezone || "America/Toronto";

  const payload = await fetchForecast(cfg, tz);
  const facts = buildWeatherFacts(payload);

  const previous = await getMeta("weather", null);
  const take = await getWeatherSummary(config, facts, { previous, force });
  const summary = take.text || previous?.summary || buildFallbackSummary(facts);
  const summaryAt = take.text ? take.at : previous?.summary ? previous.summaryAt : new Date().toISOString();

  await setMeta("weather", { ...facts, summary, summaryAt, at: new Date().toISOString() });

  log.info(
    `${facts.currentTempC}°C now, ${facts.lowC}-${facts.highC}°C (${facts.conditionLabel}) -> "${summary}"`
  );

  return [];
}
