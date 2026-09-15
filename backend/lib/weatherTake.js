// lib/weatherTake.js
//
// One short, purely DESCRIPTIVE line about today's weather, for the LED
// wall's Weather screen and (later) a chip on the website's Today page.
// Jon was explicit this round: "keep the DeepSeek calls simple for now —
// instead of actionable, I just wanted to describe the weather in concise
// detail. Hot day today, potential rain this afternoon type of thing...
// super cold, no snow, expect icy roads, something like that." So this is
// deliberately NOT the "should I bundle up / how much driving" advice line
// sketched in round 81's planning doc — no clothing advice, no driving
// recommendation, just a plain description of conditions. Simpler to build,
// cheaper to get right, and the advice version stays available as a later,
// separate step if it's ever wanted.
//
// Same split as every other AI feature here (see lib/ai.js's own header):
// sources/weather.js's buildWeatherFacts() has ALREADY decided every fact
// this reads — the icon bucket, the high/low, whether precipitation is
// expected and roughly when, whether icy roads are a real risk. This file
// only turns those already-decided facts into one well-written line. It
// never sees a raw Open-Meteo response and can't invent a number, a time of
// day, or a risk that isn't already a decided fact.
//
// Cached by content hash (lib/ids.js's cacheKey) rather than a once-a-day
// gate — same reasoning lib/newsDigest.js gives for headlines: the facts
// themselves can genuinely change more than once a day (a forecast firming
// up on rain, a temperature swing), and content-hash caching means DeepSeek
// is only called again when something actually changed, not on a fixed
// clock and not needlessly if nothing did.
//
// Degrades to null on any failure (missing key, provider off, malformed
// response) — sources/weather.js's own buildFallbackSummary() is the rule-
// based line the screen shows instead, so it is never blank just because an
// API key expired. Same "the real data is never gated on the AI step"
// convention as marketTake.js/newsDigest.js.

import { ask } from "./ai.js";
import { cacheKey } from "./ids.js";
import { logger } from "./log.js";

const log = logger("weatherTake");

const SYSTEM = `You write one short, plain description of today's weather for a personal display, from real weather facts given to you.

Return json: {"summary":"..."}

Rules:
- 1-2 sentences, under 160 characters total.
- Purely descriptive. Never give clothing advice, driving advice, or tell the reader what to do — just describe conditions, the way the opening line of a weather report would.
- Base it ONLY on the facts given below. Never invent a temperature, a chance of precipitation, or a time of day that isn't in the data.
- Mention icy roads only if icyRoadRisk is true, and only as a description of conditions ("icy roads possible"), never as an instruction.
- Plain and factual. No emoji, no hype.`;

function fmtForPrompt(facts) {
  const lines = [
    `Current: ${facts.currentTempC}°C, ${facts.conditionLabel}`,
    `High: ${facts.highC}°C, Low: ${facts.lowC}°C`,
    facts.precipWindow
      ? `Precipitation: ${facts.precipWindow.probabilityPercent}% chance of ${facts.precipWindow.kind} ${facts.precipWindow.periodLabel}`
      : "Precipitation: none expected today",
    `Icy road risk: ${facts.icyRoadRisk ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

/**
 * `facts` is sources/weather.js's already-decided buildWeatherFacts() output
 * for this pull. `previous` is the last stored `weather` meta blob, read
 * only for its `.summary`/`.summaryAt` as a fallback if this call produces
 * nothing usable — its facts are never trusted directly, only today's fresh
 * ones are. Returns `{text, at}` — `text` is null when nothing new came
 * back (model off, call failed, or malformed); the caller
 * (sources/weather.js's collectWeather) is what falls all the way back to a
 * rule-built sentence if even the previous cached one is unavailable.
 */
export async function getWeatherSummary(config, facts, { previous = null } = {}) {
  const key = cacheKey("weatherTake-v1", facts);
  const parsed = await ask({
    system: SYSTEM,
    user: `Return json.\n\n${fmtForPrompt(facts)}`,
    config,
    maxTokens: 120,
    json: true,
    cacheAs: key,
  });

  const text =
    typeof parsed?.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 200)
      : null;

  if (!text) return { text: null, at: previous?.summaryAt || null };

  const at = new Date().toISOString();
  log.info(`refreshed: ${text}`);
  return { text, at };
}
