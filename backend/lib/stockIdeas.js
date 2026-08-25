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
// Real, live signals, all from Yahoo:
//
//   1. `recommendationsBySymbol` — Yahoo's own similarity engine for "what's
//      related to this ticker," run against every ticker you hold. A
//      candidate that comes up for several of your holdings is more
//      load-bearing than one that only echoes a single position.
//   2. Yahoo's `screener` module, against a predefined small-cap screen
//      (`aggressive_small_caps` by default) — candidates that have nothing
//      to do with what you already own. The first version of this only
//      ever surfaced peers of your existing holdings, which is why it kept
//      landing on things you'd already recognize (a mega-cap bank next to
//      the mega-cap bank you already hold). This is the "actually novel"
//      half.
//   3. Your own current sector weights (real, from what you actually
//      hold) — prefers a candidate whose sector you're thin on over one
//      that piles onto a sector you're already deep in.
//   4. `financialData`'s analyst price targets — a real (if imperfect)
//      "is anyone bullish on this" signal, folded in as a bonus/penalty
//      rather than the whole story. Absent for a lot of small-caps; when
//      it's missing, it's simply not counted, not treated as a strike.
//   5. A market-cap ceiling, applied to every candidate regardless of
//      source. This is the direct fix for "the pick was BMO, a company I
//      already basically know about" — a ~$90B bank should never have
//      been eligible in the first place.
//   6. Its own short memory: the last `stockIdeaNoRepeatDays` picks are
//      excluded from re-selection, so a static portfolio doesn't just
//      re-derive the same answer every morning.
//
// The result is one factual line — ticker, sector, price, why it
// surfaced — never a pitch, never a rating, never "buy." Not investment
// advice; a research candidate for you to look at yourself.
//
// Refreshed once a calendar day (at local midnight, not every pull) — see
// getStockIdea below and lib/time.js.

import YahooFinance from "yahoo-finance2";
import { logger } from "./log.js";
import { getMeta, setMeta } from "./store.js";
import { calendarDaysBetween } from "./time.js";

const log = logger("stockIdeas");
const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const r = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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
 * (targetMeanPrice vs. live price) as a percent. Pure and testable. Null
 * whenever either side is missing — Yahoo has no analyst coverage at all
 * for a lot of small-caps, and that's a fact worth keeping distinguishable
 * from "0% upside," not collapsing into it.
 */
export function analystUpsidePct(price, targetMeanPrice) {
  if (price == null || targetMeanPrice == null || price <= 0) return null;
  return ((targetMeanPrice - price) / price) * 100;
}

/** Drop anything whose last `stockIdeaNoRepeatDays` picks already covered.
 *  Pure filter — the actual history comes from getStockIdea below. */
export function excludeRecent(candidates, recentSymbols) {
  const recent = new Set(recentSymbols || []);
  return candidates.filter((c) => !recent.has(c.symbol));
}

/**
 * Pure and testable: given enriched candidates and the book's current
 * sector weights, score and sort.
 *
 *   - `aggScore` (from recommendationsBySymbol, or a flat 1 for a
 *     screener-discovered candidate that has no Yahoo similarity score to
 *     begin with) is the base signal.
 *   - Discounted when the candidate's sector is already heavily
 *     represented in the book (concentrationPenalty) — piling onto a
 *     sector you're already deep in doesn't help rebalance anything.
 *   - Adjusted by analyst upside (analystUpsideWeight), clamped to
 *     [-30, 60]% so one stale, wild price target can't swamp everything
 *     else. A candidate with no analyst coverage at all gets no
 *     adjustment either way — absence isn't a penalty.
 */
export function rankCandidates(
  candidates,
  weights = {},
  { concentrationPenalty = 0.6, analystUpsideWeight = 0 } = {}
) {
  return candidates
    .map((c) => {
      const bucket = sectorBucket(c.sector);
      const currentWeightPct = bucket ? weights[bucket] || 0 : 0;
      const upsideFactor =
        1 + analystUpsideWeight * (clamp(c.analystUpsidePct ?? 0, -30, 60) / 100);
      const rebalanceScore =
        c.aggScore * (1 - concentrationPenalty * Math.min(1, currentWeightPct / 100)) * upsideFactor;

      const reasonBits = [];
      if (c.mentions > 1) reasonBits.push(`similar to ${c.mentions} of your holdings`);
      else if (c.mentions === 1) reasonBits.push("similar to a holding you own");
      else reasonBits.push(c.discoveredVia || "surfaced by Yahoo's small-cap screener");

      if (bucket) {
        reasonBits.push(
          currentWeightPct < 3
            ? `${bucket} is only ${currentWeightPct.toFixed(0)}% of your book`
            : bucket
        );
      }
      if (c.analystUpsidePct != null) {
        reasonBits.push(
          c.analystUpsidePct >= 0
            ? `analysts see ${c.analystUpsidePct.toFixed(0)}% upside`
            : `analysts see ${Math.abs(c.analystUpsidePct).toFixed(0)}% downside`
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
 * The "discover beyond your portfolio's orbit" half. `scrIds` is one of
 * Yahoo's predefined screens — `aggressive_small_caps` by default, tunable
 * via config.money.stockIdeaScreenerId (e.g. "small_cap_gainers" leans more
 * toward "something's moving today" than "structurally off the radar").
 * A screener miss (Yahoo changes the endpoint, a transient error) is
 * logged and skipped — this whole source is additive, never required; the
 * similarity-based candidates above still carry the refresh on their own.
 */
async function fetchScreenerCandidates(scrIds, count, held, debug) {
  try {
    const res = await yahoo.screener({ scrIds, count });
    return (res?.quotes || [])
      .map((q) => q.symbol)
      .filter((s) => s && !held.has(s));
  } catch (err) {
    log.warn(`screener(${scrIds}) failed: ${err.message}`);
    debug.screenerError = err.message;
    return [];
  }
}

/**
 * The actual Yahoo calls: a batched `recommendationsBySymbol` for the whole
 * book, a `screener` pull for the small-cap discovery pool, then one
 * `quoteSummary` (price + sector + business summary + analyst target) per
 * shortlisted candidate from either source. Not cheap enough to run every
 * 15-minute pull — this is what the day-boundary check in getStockIdea is
 * for.
 *
 * Every path through this — including every "found nothing" exit — records
 * a `stockIdeaDebug` blob in `meta` naming exactly where it stopped, since
 * "the spot is just empty" gives you nothing to go on otherwise. Check it
 * with `npm run refresh-stock-idea` if a refresh isn't turning up a
 * candidate and it's not obvious why.
 */
export async function refreshStockIdea(config, { holdings, positions }, { recentSymbols = [] } = {}) {
  const debug = {
    at: new Date().toISOString(),
    tickerCount: 0, recCount: 0, screenerCount: 0, shortlistCount: 0, enrichedCount: 0,
    marketCapExcluded: [], recentExcluded: [], usedRecentFallback: false,
    chunkErrors: [], noSummary: [], screenerError: null, note: null,
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
  const held = new Set(tickers);

  // -------------------------------------------------------- source 1: similar
  const recs = await fetchRecommendations(tickers, debug);
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

  const similarShortlistSize = config.money?.stockIdeaShortlist ?? 8;
  const similarShortlist = [...agg.entries()]
    .map(([symbol, e]) => ({
      symbol, aggScore: e.totalScore / e.mentions, mentions: e.mentions, discoveredVia: null,
    }))
    .sort((a, b) => b.aggScore - a.aggScore || b.mentions - a.mentions)
    .slice(0, similarShortlistSize);

  // ------------------------------------------------- source 2: small-cap screen
  const scrIds = config.money?.stockIdeaScreenerId || "aggressive_small_caps";
  const screenerShortlistSize = config.money?.stockIdeaScreenerShortlist ?? 10;
  const screenerSymbols = await fetchScreenerCandidates(scrIds, screenerShortlistSize, held, debug);
  debug.screenerCount = screenerSymbols.length;
  const screenerShortlist = screenerSymbols
    .filter((s) => !agg.has(s)) // already covered by the similarity source
    .map((symbol) => ({
      symbol, aggScore: 1, mentions: 0, discoveredVia: `surfaced by Yahoo's ${scrIds.replace(/_/g, " ")} screen`,
    }));

  let shortlist = [...similarShortlist, ...screenerShortlist];
  debug.shortlistCount = shortlist.length;

  if (!shortlist.length) {
    return finish(
      debug.chunkErrors.length && debug.screenerError
        ? "both the recommendation source and the screener failed — see chunkErrors / screenerError"
        : "no candidates from either source (outside what you already hold)",
      null
    );
  }

  // No-repeat: excluded first, before spending API calls enriching a
  // candidate we wouldn't use anyway. If exclusion would empty the whole
  // pool (a small book against a narrow screen), fall back to allowing a
  // repeat rather than showing nothing — a repeat is a better outcome than
  // a blank panel, and it's recorded (usedRecentFallback) so it's visible
  // this happened rather than looking like the memory silently isn't
  // working.
  const withoutRecent = excludeRecent(shortlist, recentSymbols);
  if (withoutRecent.length) {
    debug.recentExcluded = shortlist
      .filter((c) => !withoutRecent.includes(c))
      .map((c) => c.symbol);
    shortlist = withoutRecent;
  } else if (shortlist.length) {
    debug.usedRecentFallback = true;
  }

  const summarySentences = config.money?.stockIdeaSummarySentences ?? 2;
  const summaryMaxChars = config.money?.stockIdeaSummaryMaxChars ?? 220;
  const maxMarketCap = config.money?.stockIdeaMaxMarketCap ?? 15_000_000_000;

  const enriched = [];
  const enrichErrors = [];
  const noSummary = [];
  for (const c of shortlist) {
    // One call, three modules — price (live price + market cap + name),
    // assetProfile (sector + business summary) and financialData (analyst
    // targets). Each field is read defensively below: a module coming back
    // empty for this ticker is common (financialData especially, for a
    // small-cap with no analyst coverage) and isn't treated as a fetch
    // failure.
    let data = null, fetchError = null;
    try {
      data = await yahoo.quoteSummary(c.symbol, { modules: ["price", "assetProfile", "financialData"] });
    } catch (err) {
      fetchError = err.message;
    }

    const price = data?.price?.regularMarketPrice ?? null;
    if (!price) {
      enrichErrors.push(`${c.symbol}: no live price${fetchError ? ` (${fetchError})` : ""}`);
      continue;
    }

    const marketCap = data?.price?.marketCap ?? null;
    // A rough filter, not FX-normalised — a USD and a CAD market cap are
    // compared against the same raw ceiling. Close enough to keep obvious
    // mega-caps out (see the BMO case this whole change exists to fix);
    // not precise enough to lean on at the margin.
    if (marketCap != null && marketCap > maxMarketCap) {
      debug.marketCapExcluded.push(`${c.symbol}: ${(marketCap / 1e9).toFixed(1)}B`);
      continue;
    }

    const summary = firstSentences(data?.assetProfile?.longBusinessSummary, {
      sentences: summarySentences, maxChars: summaryMaxChars,
    });
    if (!summary) {
      noSummary.push(
        fetchError
          ? `${c.symbol}: quoteSummary fetch failed (${fetchError}) — unknown whether Yahoo has a summary`
          : data?.assetProfile
            ? `${c.symbol}: assetProfile came back, but no longBusinessSummary field on it`
            : `${c.symbol}: assetProfile module came back empty for this ticker`
      );
    }

    enriched.push({
      symbol: c.symbol,
      name: data?.price?.shortName || data?.price?.longName || c.symbol,
      price: r(price, 2),
      currency: data?.price?.currency || null,
      marketCap: marketCap != null ? r(marketCap, 0) : null,
      sector: data?.assetProfile?.sector || null,
      summary,
      aggScore: r(c.aggScore, 4),
      mentions: c.mentions,
      discoveredVia: c.discoveredVia,
      analystUpsidePct: r(analystUpsidePct(price, data?.financialData?.targetMeanPrice ?? null), 1),
    });
  }
  debug.enrichedCount = enriched.length;
  if (enrichErrors.length) debug.chunkErrors.push(...enrichErrors);
  debug.noSummary = noSummary;

  if (!enriched.length) {
    return finish(
      debug.marketCapExcluded.length && !debug.chunkErrors.length
        ? "every shortlisted candidate was above the market-cap ceiling — see marketCapExcluded"
        : "every shortlisted candidate failed to enrich (no live price, or the lookup itself failed)",
      null
    );
  }

  const concentrationPenalty = config.money?.stockIdeaConcentrationPenalty ?? 0.6;
  const analystUpsideWeight = config.money?.stockIdeaAnalystUpsideWeight ?? 0.5;
  const ranked = rankCandidates(enriched, sectorWeights(positions), {
    concentrationPenalty, analystUpsideWeight,
  });
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
 *
 * Keeps a short memory of past picks (`stockIdeaHistory`, capped at
 * `stockIdeaNoRepeatDays`) so a static portfolio doesn't just re-derive the
 * same answer morning after morning — see refreshStockIdea's no-repeat
 * step and excludeRecent above.
 */
export async function getStockIdea(config, { holdings, positions }, { force = false } = {}) {
  const tz = config.timezone || "America/Toronto";
  const refreshDays = Math.max(1, config.money?.stockIdeaRefreshDays ?? 1);
  const cached = await getMeta("stockIdea", null);
  const stale = force || !cached || calendarDaysBetween(cached.at, new Date().toISOString(), tz) >= refreshDays;

  if (!stale) return cached;

  const noRepeatDays = Math.max(0, config.money?.stockIdeaNoRepeatDays ?? 10);
  const history = (await getMeta("stockIdeaHistory", [])) || [];
  const recentSymbols = history.slice(0, noRepeatDays).map((h) => h.symbol);

  const fresh = await refreshStockIdea(config, { holdings, positions }, { recentSymbols });
  if (fresh) {
    await setMeta("stockIdea", fresh);
    const pickedSymbols = fresh.candidates.map((c) => c.symbol);
    const nextHistory = [
      ...pickedSymbols.map((symbol) => ({ symbol, at: fresh.at })),
      ...history,
    ].slice(0, Math.max(noRepeatDays, 1) * 2); // a little slack past the window itself
    await setMeta("stockIdeaHistory", nextHistory);
    log.info(`stock idea refreshed: ${pickedSymbols.join(", ") || "none found"}`);
    return fresh;
  }

  // The refresh failed or found nothing this cycle — keep serving the old
  // cached value (if any) rather than blanking a working panel over a
  // transient Yahoo hiccup.
  return cached;
}
