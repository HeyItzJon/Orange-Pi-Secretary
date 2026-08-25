// lib/stockIdeas.js
//
// One ticker, related to what you already hold, that might help
// diversify the book. This existed once as `opportunityGenerator.js` — an
// AI wrote a daily "stock pitch" grounded in hand-typed, fabricated macro
// data (a fake Fed rate, invented sector performance, made-up geopolitical
// risks). It got deleted for exactly that reason: it was confidently
// wrong by construction, and manufactured urgency in a domain where doing
// nothing is usually correct.
//
// This version doesn't do that. No AI call, no invented data, no verdict.
// Two real, live signals, both from Yahoo:
//
//   1. `recommendationsBySymbol` — Yahoo's own similarity engine (price
//      correlation, sector, and other real signals) for "what's related to
//      this ticker." Run against every ticker you hold, in one batched
//      call, then aggregated: a candidate that comes up for several of
//      your holdings is more load-bearing than one that only echoes a
//      single position.
//   2. Your own current sector weights (real, from what you actually
//      hold) — used only to prefer a candidate whose sector you're
//      thin on over one that piles onto a sector you're already deep in.
//      That's the "help rebalance" half of the ask.
//
// The result is one factual line — ticker, sector, price, why it
// surfaced — never a pitch, never a rating, never "buy." Not investment
// advice; a research candidate for you to look at yourself.
//
// Refreshed once a calendar day (at local midnight, not every pull) — see
// getStockIdea below and lib/time.js. Yahoo's recommendation + profile
// calls are heavier than a routine price pull, and this is a slow-moving
// signal that doesn't need to be checked every 15 minutes.

import YahooFinance from "yahoo-finance2";
import { logger } from "./log.js";
import { getMeta, setMeta } from "./store.js";
import { calendarDaysBetween } from "./time.js";

const log = logger("stockIdeas");
const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const r = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));

/**
 * The first sentence or two of Yahoo's business-summary blurb, trimmed to a
 * length that fits a spot originally sized for a ticker and a percent. Pure
 * string handling — no invented text, just less of Yahoo's own text than
 * the full paragraph. Returns null for anything empty so the UI can tell
 * "no summary available" apart from "summary is blank."
 */
export function firstSentences(text, { sentences = 2, maxChars = 220 } = {}) {
  if (!text) return null;
  const parts = String(text).trim().split(/(?<=[.!?])\s+/).slice(0, sentences);
  let out = parts.join(" ").trim();
  if (!out) return null;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).replace(/\s+\S*$/, "").trim() + "…";
  }
  return out || null;
}

// Yahoo's sector strings for real tickers are broad ("Technology",
// "Financial Services", "Healthcare", ...). The vault's own sector field is
// a hand-written, much more granular label ("Technology - Fintech",
// "ETF - Canadian Equity"). Bucketing on the text before " - " lines the
// two up well enough for a rough weight comparison — not a rigorous GICS
// mapping, just enough signal to tell "you have plenty of this" from "you
// have none of this."
const SECTOR_ALIASES = {
  Financials: "Financial Services",
  Tech: "Technology",
};

export function sectorBucket(rawSector) {
  if (!rawSector) return null;
  const head = String(rawSector).split(" - ")[0].trim();
  return SECTOR_ALIASES[head] || head;
}

/** Current weight (%) per sector bucket, from the priced positions money.js
 *  already computed — real portfolio weights, not a guess. */
export function sectorWeights(positions) {
  const weights = {};
  for (const p of positions || []) {
    if (p.value == null) continue;
    const bucket = sectorBucket(p.sector);
    if (!bucket) continue;
    weights[bucket] = (weights[bucket] || 0) + (p.weightPct || 0);
  }
  return weights;
}

/**
 * Pure and testable: given enriched candidates and the book's current
 * sector weights, score and sort. Higher `aggScore` (Yahoo's own
 * similarity signal, averaged across every one of your holdings that
 * surfaced it) is better; a candidate whose sector is already heavily
 * represented in the book is discounted, since piling onto a sector you're
 * already deep in doesn't help rebalance anything.
 */
export function rankCandidates(candidates, weights = {}, { concentrationPenalty = 0.6 } = {}) {
  return candidates
    .map((c) => {
      const bucket = sectorBucket(c.sector);
      const currentWeightPct = bucket ? weights[bucket] || 0 : 0;
      const rebalanceScore = c.aggScore * (1 - concentrationPenalty * Math.min(1, currentWeightPct / 100));
      const reasonBits = [];
      reasonBits.push(
        c.mentions > 1 ? `similar to ${c.mentions} of your holdings` : "similar to a holding you own"
      );
      if (bucket) {
        reasonBits.push(
          currentWeightPct < 3
            ? `${bucket} is only ${currentWeightPct.toFixed(0)}% of your book`
            : bucket
        );
      }
      return {
        ...c,
        sectorBucket: bucket,
        currentSectorWeightPct: r(currentWeightPct, 1),
        rebalanceScore: r(rebalanceScore, 4),
        reason: reasonBits.join(" · "),
      };
    })
    .sort((a, b) => b.rebalanceScore - a.rebalanceScore);
}

/**
 * `recommendationsBySymbol` puts every symbol straight into the request
 * URL's path (comma-joined) rather than a query param — fine for a handful
 * of tickers, untested at the size of a real multi-decade portfolio. This
 * chunks the call the same way `sources/money.js`'s `quoteAll` already
 * chunks price lookups, so a book with 40+ holdings can't hit some
 * undocumented Yahoo limit and silently come back empty. One chunk
 * failing is logged and skipped rather than sinking the whole refresh.
 */
async function fetchRecommendations(tickers, debug) {
  const size = 15;
  const all = [];
  for (let i = 0; i < tickers.length; i += size) {
    const chunk = tickers.slice(i, i + size);
    try {
      const res = await yahoo.recommendationsBySymbol(chunk);
      all.push(...(Array.isArray(res) ? res : [res]));
    } catch (err) {
      log.warn(`recommendationsBySymbol chunk failed (${chunk.join(",")}): ${err.message}`);
      debug.chunkErrors.push(`${chunk.length} tickers: ${err.message}`);
    }
  }
  return all;
}

/**
 * The actual Yahoo calls: one batched (possibly chunked) `recommendationsBySymbol`
 * for the whole book, then a `quoteSummary` (sector + business summary) +
 * `quote` (price/name) per shortlisted candidate. Not cheap enough to run
 * every 15-minute pull — this is what the TTL in getStockIdea is for.
 *
 * Every path through this — including every "found nothing" exit — records
 * a `stockIdeaDebug` blob in `meta` naming exactly where it stopped, since
 * "the spot is just empty" gives you nothing to go on otherwise. Check it
 * with `npm run refresh-stock-idea` if a refresh isn't turning up a
 * candidate and it's not obvious why.
 */
export async function refreshStockIdea(config, { holdings, positions }) {
  const debug = {
    at: new Date().toISOString(),
    tickerCount: 0, recCount: 0, shortlistCount: 0, enrichedCount: 0,
    chunkErrors: [], noSummary: [], note: null,
  };
  const finish = async (note, result) => {
    debug.note = note;
    try { await setMeta("stockIdeaDebug", debug); } catch { /* diagnostics only */ }
    return result;
  };

  const tickers = [...new Set((holdings || []).map((h) => h.ticker).filter(Boolean))];
  debug.tickerCount = tickers.length;
  if (tickers.length < 2) {
    return finish("fewer than 2 holdings with a ticker — nothing to correlate against", null);
  }

  const recs = await fetchRecommendations(tickers, debug);
  if (!recs.length && debug.chunkErrors.length) {
    return finish("every recommendationsBySymbol chunk failed — see chunkErrors", null);
  }

  const held = new Set(tickers);
  const agg = new Map(); // symbol -> { totalScore, mentions }
  for (const result of recs) {
    for (const rec of result?.recommendedSymbols || []) {
      if (!rec?.symbol || held.has(rec.symbol)) continue;
      const e = agg.get(rec.symbol) || { totalScore: 0, mentions: 0 };
      e.totalScore += rec.score || 0;
      e.mentions += 1;
      agg.set(rec.symbol, e);
    }
  }
  debug.recCount = agg.size;

  const shortlistSize = config.money?.stockIdeaShortlist ?? 8;
  const shortlist = [...agg.entries()]
    .map(([symbol, e]) => ({ symbol, aggScore: e.totalScore / e.mentions, mentions: e.mentions }))
    .sort((a, b) => b.aggScore - a.aggScore || b.mentions - a.mentions)
    .slice(0, shortlistSize);
  debug.shortlistCount = shortlist.length;

  if (!shortlist.length) {
    return finish("Yahoo returned no related symbols (outside what you already hold) for any ticker", null);
  }

  const summarySentences = config.money?.stockIdeaSummarySentences ?? 2;
  const summaryMaxChars = config.money?.stockIdeaSummaryMaxChars ?? 220;

  const enriched = [];
  const enrichErrors = [];
  const noSummary = [];
  for (const c of shortlist) {
    // profile and quote are fetched (and can fail) independently — a bank
    // holiday quote hiccup shouldn't take the business summary down with
    // it, and vice versa. Each failure is caught on its own so the reason
    // a summary is missing can actually be told apart from "the fetch
    // itself broke," instead of both collapsing into the same silent null
    // the way a shared `.catch(() => null)` on a combined Promise.all
    // would (that's exactly what this replaced — see the note in the
    // project doc on the BMO case, where that silence was the whole
    // problem).
    let profile = null, profileError = null;
    try {
      profile = await yahoo.quoteSummary(c.symbol, { modules: ["assetProfile"] });
    } catch (err) {
      profileError = err.message;
    }
    let quote = null, quoteError = null;
    try {
      quote = await yahoo.quote(c.symbol);
    } catch (err) {
      quoteError = err.message;
    }

    // No live price means nothing real to show — skip rather than
    // surface a candidate with a blank number.
    if (!quote?.regularMarketPrice) {
      enrichErrors.push(`${c.symbol}: no live quote${quoteError ? ` (${quoteError})` : ""}`);
      continue;
    }

    const summary = firstSentences(profile?.assetProfile?.longBusinessSummary, {
      sentences: summarySentences, maxChars: summaryMaxChars,
    });
    if (!summary) {
      noSummary.push(
        profileError
          ? `${c.symbol}: assetProfile fetch failed (${profileError}) — unknown whether Yahoo has one`
          : profile?.assetProfile
            ? `${c.symbol}: assetProfile came back, but no longBusinessSummary field on it`
            : `${c.symbol}: assetProfile module came back empty for this ticker`
      );
    }

    enriched.push({
      symbol: c.symbol,
      name: quote.shortName || quote.longName || c.symbol,
      price: r(quote.regularMarketPrice, 2),
      currency: quote.currency || null,
      sector: profile?.assetProfile?.sector || null,
      summary,
      aggScore: r(c.aggScore, 4),
      mentions: c.mentions,
    });
  }
  debug.enrichedCount = enriched.length;
  if (enrichErrors.length) debug.chunkErrors.push(...enrichErrors);
  debug.noSummary = noSummary;

  if (!enriched.length) {
    return finish("every shortlisted candidate failed to enrich (no live price, or the lookup itself failed)", null);
  }

  const concentrationPenalty = config.money?.stockIdeaConcentrationPenalty ?? 0.6;
  const ranked = rankCandidates(enriched, sectorWeights(positions), { concentrationPenalty });
  const count = config.money?.stockIdeaCount ?? 1;
  return finish("ok", { at: new Date().toISOString(), candidates: ranked.slice(0, count) });
}

/**
 * Refreshed once a calendar day, not once every N hours: a new pick shows
 * up the first time this is checked after local midnight
 * (config.timezone), however many minutes that turns out to be after the
 * last refresh — never on a rolling "24 hours since last time" clock,
 * which would let a sync at 11:58 PM push the next one out to nearly
 * midnight the FOLLOWING day. `config.money.stockIdeaRefreshDays` (default
 * 1) is the tuning knob if daily turns out to be too chatty or too slow —
 * every-other-day, every three days, whatever. See lib/time.js for the
 * calendar-day math this is built on.
 */
export async function getStockIdea(config, { holdings, positions }, { force = false } = {}) {
  const tz = config.timezone || "America/Toronto";
  const refreshDays = Math.max(1, config.money?.stockIdeaRefreshDays ?? 1);
  const cached = await getMeta("stockIdea", null);
  const stale = force || !cached || calendarDaysBetween(cached.at, new Date().toISOString(), tz) >= refreshDays;

  if (!stale) return cached;

  const fresh = await refreshStockIdea(config, { holdings, positions });
  if (fresh) {
    await setMeta("stockIdea", fresh);
    log.info(`stock idea refreshed: ${fresh.candidates.map((c) => c.symbol).join(", ") || "none found"}`);
    return fresh;
  }

  // The refresh failed or found nothing this cycle — keep serving the old
  // cached value (if any) rather than blanking a working panel over a
  // transient Yahoo hiccup.
  return cached;
}
