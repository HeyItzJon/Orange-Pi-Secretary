// lib/weatherTake.js
//
// One short line about today's weather, for the LED wall's Weather screen
// and the website's Weather page. Round 82's brief was purely descriptive
// ("hot day today, potential rain this afternoon... super cold, no snow,
// expect icy roads") — deliberately no clothing or driving advice. Round 87
// flips that: Jon already sees the current temp and today's high/low right
// next to this line on both the wall and the dashboard, so a summary that
// just restates them is wasted space. He wants the ONE thing that isn't
// already visible — how today compares to yesterday, when the heat actually
// peaks, a real-but-minor risk worth a heads-up ("might snow but low
// chance") — and he explicitly invited dry, "smart-ass" wit when there's a
// today's event to hang it on ("bring a sweater to your 5 PM game," "you'll
// be sweaty by your noon run"). Never told to be funny in general — only
// when a real event+time makes the joke land on something true.
//
// Same split as every other AI feature here (see lib/ai.js's own header):
// sources/weather.js's buildWeatherFacts() has ALREADY decided every fact
// this reads — the icon bucket, the high/low (given for context, not for
// restating), the yesterday comparison (compareToYesterday), the day's peak
// heat (peakHeatSlot), whether precipitation is expected and roughly when,
// whether icy roads are a real risk — and collectWeather() has already
// pulled today's remaining calendar events (buildTodaysEvents). This file
// only turns those already-decided facts into one well-written line. It
// never sees a raw Open-Meteo response or the item store directly, and
// can't invent a number, a time, an event, or a risk that isn't already a
// decided fact handed to it.
//
// Cached by content hash (lib/ids.js's cacheKey) rather than a once-a-day
// gate — same reasoning lib/newsDigest.js gives for headlines: the facts
// themselves can genuinely change more than once a day (a forecast firming
// up on rain, a temperature swing, an event getting added or moved), and
// content-hash caching means DeepSeek is only called again when something
// actually changed, not on a fixed clock and not needlessly if nothing did.
// Bumped to a new cache-key version (v2) with this round's rewrite so an
// old cached line under the old "purely descriptive" prompt is never served
// back as if it were written under the new one.
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

const SYSTEM = `You write one short, punchy line about today's weather for a personal LED display. The reader can already see today's current temperature and its high/low right next to this line — your only job is to add the ONE thing that isn't already visible.

Return json: {"summary":"..."}

Rules:
- 1 sentence, under 140 characters.
- NEVER state an exact high or exact low temperature, and never use phrasing like "high of X" or "low of Y" — the reader already sees those numbers elsewhere on the same screen.
- Pick the single most interesting angle available, in this rough priority: (1) a real, specific, practical nudge tied to one of today's remaining events and its exact time, if one is given — dry and a little witty is great here ("bring a sweater to your 5 PM game," "you'll be sweaty by your noon run") — but it must reference an event and time actually given below, never an invented one; (2) how today compares to yesterday, if that comparison is genuinely notable (skip it if vsYesterday is "about the same"); (3) when the peak heat actually hits, if that's a useful thing to flag; (4) a real but minor risk worth a heads-up, phrased plainly ("might snow, but only a low chance"). Never stack more than one of these — pick the best one and say it well.
- If nothing below is genuinely interesting (mild, unremarkable, no events, no notable change from yesterday), it's fine to fall back to one plain, factual sentence about conditions — don't force a joke or a comparison that isn't there.
- Base every claim ONLY on the facts given below. Never invent a temperature, a percentage, a time, an event, or a risk that isn't in the data.
- Mention icy roads only if icyRoadRisk is true, and only as a description of conditions ("icy roads possible"), never as an instruction.
- Dry wit is welcome where the rules above call for it. Never mean-spirited, never nagging, never actual advice like "wear a coat" outside of the event-nudge case above. No emoji, no exclamation points, no "stay safe" or "have a great day" filler.`;

function fmtForPrompt(facts, todaysEvents) {
  const lines = [
    `Current: ${facts.currentTempC}°C, ${facts.conditionLabel}`,
    `Today's high/low (context only — never restate these numbers): ${facts.highC}°C / ${facts.lowC}°C`,
    facts.vsYesterday
      ? `vsYesterday: ${facts.vsYesterday} than yesterday (yesterday's high was ${facts.yesterdayHighC}°C)`
      : "vsYesterday: not available",
    facts.peakHeat
      ? `Peak heat today: ${facts.peakHeat.tempC}°C around ${facts.peakHeat.hourLabel}`
      : "Peak heat time: not available",
    facts.precipWindow
      ? `Precipitation: ${facts.precipWindow.probabilityPercent}% chance of ${facts.precipWindow.kind} ${facts.precipWindow.periodLabel}`
      : "Precipitation: none expected today",
    `Icy road risk: ${facts.icyRoadRisk ? "yes" : "no"}`,
  ];
  if (todaysEvents?.length) {
    lines.push("Today's remaining events (only ones you may reference):");
    todaysEvents.forEach((e) => lines.push(`- ${e.time}: ${e.title}`));
  } else {
    lines.push("Today's remaining events: none");
  }
  return lines.join("\n");
}

/**
 * `facts` is sources/weather.js's already-decided buildWeatherFacts() output
 * for this pull. `todaysEvents` is that file's buildTodaysEvents() output —
 * today's still-upcoming timed calendar events, `[{title, time}]`, already
 * filtered and capped. `previous` is the last stored `weather` meta blob,
 * read only for its `.summary`/`.summaryAt` as a fallback if this call
 * produces nothing usable — its facts are never trusted directly, only
 * today's fresh ones are. Returns `{text, at}` — `text` is null when
 * nothing new came back (model off, call failed, or malformed); the caller
 * (sources/weather.js's collectWeather) is what falls all the way back to a
 * rule-built sentence if even the previous cached one is unavailable.
 */
export async function getWeatherSummary(config, facts, { previous = null, todaysEvents = [] } = {}) {
  const key = cacheKey("weatherTake-v2", { facts, todaysEvents });
  const parsed = await ask({
    system: SYSTEM,
    user: `Return json.\n\n${fmtForPrompt(facts, todaysEvents)}`,
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
