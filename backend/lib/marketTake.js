// lib/marketTake.js
//
// One DeepSeek sentence a day, summarizing REAL market data handed to it by
// sources/marketNews.js — real index moves, the real VIX reading, real
// headlines. It is never asked to predict what happens next, and never
// asked to recommend buying, selling, or holding anything. This is the
// guardrail an earlier planning doc in this project (secretary-proposal.md)
// asked for after finding a prior version of this app fed the model
// entirely FABRICATED macro data under a "Market Reality" heading: the
// model here only ever reads and writes real numbers, it does not invent
// or judge them.
//
// Refreshed once per calendar day (config.marketNews.takeRefreshDays,
// default 1), same day-boundary cache pattern as lib/stockIdeas.js's
// getStockIdea() — deliberately NOT ask()'s own content-hash cache
// (lib/ai.js's `cacheAs`), because the real content genuinely changes on
// every 15-minute pull (headlines turn over, index levels move), which
// would defeat a content-based cache and call the model far more than
// once a day. `force` bypasses the gate, same as `npm run
// refresh-stock-idea` does for stock ideas — see scripts/refresh-market-
// news.js.
//
// Degrades to null on any failure (missing key, provider off, malformed
// response, or just nothing real to summarize yet) — the real indices/VIX/
// headlines sources/marketNews.js already collected are never gated on
// this succeeding; only the one "Today's take" line goes quiet.

import { ask } from "./ai.js";
import { calendarDaysBetween } from "./time.js";
import { logger } from "./log.js";

const log = logger("marketTake");

const SYSTEM = `You write one short sentence summarizing today's real stock market conditions, for a personal finance dashboard.

Return json: {"take":"..."}

Rules:
- Exactly one sentence, under 200 characters.
- Base it ONLY on the real index moves, VIX reading, and headlines given below. Never invent a number, an event, or a cause that isn't in the data.
- Never predict what happens next. Never recommend buying, selling, or holding anything, and never characterize a move as good or bad news for the reader personally.
- Plain and factual, like the opening line of a newspaper market-wrap. No emoji, no hype, no "to the moon" or "bloodbath" language.
- If the data is thin (few or no headlines, indices roughly flat), say that plainly rather than padding it out.`;

function fmtForPrompt(pulse) {
  const lines = [];
  if (pulse.indices?.length) {
    lines.push("Indices today:");
    for (const i of pulse.indices) {
      lines.push(`  ${i.label}: ${i.pct == null ? "no data" : `${i.pct > 0 ? "+" : ""}${i.pct.toFixed(2)}%`}`);
    }
  }
  if (pulse.vix) lines.push(`VIX: ${pulse.vix.value.toFixed(1)} (${pulse.vix.bucket})`);
  if (pulse.headlines?.length) {
    lines.push("Recent headlines:");
    for (const h of pulse.headlines.slice(0, 8)) lines.push(`  - ${h.title}`);
  }
  return lines.join("\n") || "No market data available today.";
}

/**
 * `pulse` is this pull's real, already-collected data (indices/vix/
 * headlines — see sources/marketNews.js). `previous` is the last stored
 * marketPulse blob; only its `takeAt` timestamp is read from it (to decide
 * whether a new sentence is due), never its content, so a stale previous
 * pull can never leak into today's line. Returns `{text, at}` — `text` is
 * null when nothing new was generated (either the gate says it's not due
 * yet, or the model/produced nothing usable), in which case `at` carries
 * forward the previous timestamp unchanged.
 */
export async function getMarketTake(config, pulse, { previous = null, force = false } = {}) {
  const tz = config.timezone || "America/Toronto";
  const refreshDays = Math.max(1, config.marketNews?.takeRefreshDays ?? 1);
  const prevAt = previous?.takeAt || null;
  const stale = force || !prevAt || calendarDaysBetween(prevAt, new Date().toISOString(), tz) >= refreshDays;

  if (!stale) return { text: previous?.take ?? null, at: prevAt };

  // Nothing real to summarize yet (e.g. every feed and the index pull both
  // failed this run) — don't spend a call describing silence.
  if (!pulse.indices?.some((i) => i.pct != null) && !pulse.headlines?.length) {
    return { text: previous?.take ?? null, at: prevAt };
  }

  const parsed = await ask({
    system: SYSTEM,
    user: `Return json.\n\n${fmtForPrompt(pulse)}`,
    config,
    maxTokens: 120,
    json: true,
  });

  const text = typeof parsed?.take === "string" && parsed.take.trim() ? parsed.take.trim().slice(0, 240) : null;
  if (!text) return { text: previous?.take ?? null, at: prevAt };

  const at = new Date().toISOString();
  log.info(`refreshed: ${text}`);
  return { text, at };
}
