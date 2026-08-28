// lib/stockIdeaDetail.js
//
// On-demand, click-to-expand detail for the Finances page's one daily
// "Worth a look" stock idea (see lib/stockIdeas.js) — same on-demand shape
// and cost model as brief/detail.js's item detail (nothing runs until a
// person actually taps the card), but a different caching strategy, because
// the underlying data is different in kind:
//
//   - brief/detail.js's facts are already sitting in the local item store
//     for free; only the AI call needs deduping, so it caches just that
//     (by item id + contentHash) and re-reads the facts fresh every click.
//   - This module's facts are a LIVE Yahoo pull (quoteSummary + a
//     recommendationsBySymbol call for competitors) — not free, and not
//     something to re-fetch on every re-open of the same day's card. So
//     this caches the WHOLE result — facts and the AI narrative together —
//     for the calendar day, and a second click the same day costs nothing
//     at all, Yahoo included.
//
// Jon's own explicit requirement: a day boundary must never serve stale
// data, even for a ticker that recurs (stockIdeaNoRepeatDays lapses
// eventually, so the same symbol CAN come back around). The cache key is
// the plain local calendar date (lib/time.js's localDateKey), not tied to
// stockIdeaRefreshDays or to the stock idea's own `at` timestamp — so it's
// keyed on the same "midnight" every other daily cache in this app already
// agrees on, and a stale entry from a previous day is simply never a match,
// regardless of why today's request came in.
//
// Same guardrail as everywhere else AI touches this app: rules assemble the
// facts, the model only narrates them. No invented competitor, no
// fabricated rating, no price target that isn't actually Yahoo's.

import YahooFinance from "yahoo-finance2";
import { logger } from "./log.js";
import { ask } from "./ai.js";
import { cacheKey } from "./ids.js";
import { getMeta, setMeta } from "./store.js";
import { localDateKey } from "./time.js";
import { analystUpsidePct } from "./stockIdeas.js";

const log = logger("stockIdeaDetail");
const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const r = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));

const RECOMMENDATION_LABELS = {
  strong_buy: "Strong buy",
  buy: "Buy",
  hold: "Hold",
  underperform: "Underperform",
  sell: "Sell",
};

export function recommendationLabel(key) {
  if (!key) return null;
  return RECOMMENDATION_LABELS[key] || key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Deterministic, no AI — always present even when the model is off or the
 * competitor/analyst lookups came back thin, so a click never shows a blank
 * panel. `businessSummary` is Yahoo's FULL blurb, deliberately untrimmed
 * (unlike lib/stockIdeas.js's firstSentences() used on the compact card) —
 * the whole point of this panel is the longer version. Capped at 4000 chars
 * purely as a defensive ceiling against a pathological response, not to
 * shorten a normal one (Yahoo's real bios run a few hundred words).
 */
export function buildFacts({ ticker, quoteSummary, competitorQuotes }) {
  const price = quoteSummary?.price || {};
  const profile = quoteSummary?.assetProfile || {};
  const summaryDetail = quoteSummary?.summaryDetail || {};
  const financialData = quoteSummary?.financialData || {};

  const businessSummary = profile.longBusinessSummary
    ? String(profile.longBusinessSummary).trim().slice(0, 4000)
    : null;

  const currentPrice = financialData.currentPrice ?? price.regularMarketPrice ?? null;

  return {
    ticker,
    name: price.shortName || price.longName || ticker,
    price: r(currentPrice, 2),
    currency: price.currency || null,
    sector: profile.sector || null,
    industry: profile.industry || null,
    website: profile.website || null,
    employees: profile.fullTimeEmployees ?? null,
    marketCap: summaryDetail.marketCap ?? price.marketCap ?? null,
    businessSummary,
    yahooUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
    trailingPE: r(summaryDetail.trailingPE, 1),
    fiftyTwoWeekLow: r(summaryDetail.fiftyTwoWeekLow, 2),
    fiftyTwoWeekHigh: r(summaryDetail.fiftyTwoWeekHigh, 2),
    dividendYieldPct: summaryDetail.dividendYield != null ? r(summaryDetail.dividendYield * 100, 2) : null,
    recommendationKey: financialData.recommendationKey || null,
    recommendationLabel: recommendationLabel(financialData.recommendationKey),
    recommendationMean: r(financialData.recommendationMean, 1),
    numberOfAnalystOpinions: financialData.numberOfAnalystOpinions ?? null,
    targetMeanPrice: r(financialData.targetMeanPrice, 2),
    targetHighPrice: r(financialData.targetHighPrice, 2),
    targetLowPrice: r(financialData.targetLowPrice, 2),
    analystUpsidePct: r(analystUpsidePct(currentPrice, financialData.targetMeanPrice ?? null), 1),
    // Up to 5 of Yahoo's own "similar companies" for THIS ticker specifically
    // (the same recommendationsBySymbol call lib/stockIdeas.js uses to find
    // the idea in the first place, just run against the candidate itself
    // rather than against your holdings) — real competitor names, never a
    // guess. Empty when Yahoo has nothing for this symbol, which is common
    // for a small-cap; the AI prompt is told to say so rather than invent one.
    competitors: (competitorQuotes || []).map((q) => ({
      ticker: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: r(q.regularMarketPrice, 2),
      currency: q.currency || null,
    })),
  };
}

const SYSTEM = `You help a university student who also works part-time understand one specific stock they just tapped for more detail — a research candidate their dashboard surfaced, related to what they already hold, NOT investment advice and never a recommendation to buy or sell.

Return json with this exact shape:
{"business":"...","competitive":"...","analysts":"..."}

Rules:
- "business": 2-4 plain sentences on what the company actually does and how it makes money, grounded ONLY in the business summary and sector/industry given — never invent a product, market, or fact not stated.
- "competitive": 2-3 plain sentences on how it stacks up against the competitors listed. If no competitors are given, say plainly that Yahoo doesn't have comparable companies on file for this one rather than naming any yourself.
- "analysts": 2-3 plain sentences on what Wall Street analysts currently think — the rating, how many analysts, and the price target versus the current price — in plain English (e.g. "analysts are mildly bullish" rather than just repeating the raw numbers). If there's no analyst coverage at all, say so plainly rather than inventing sentiment.
- Never say "buy," "sell," or give your own recommendation — describe what the data says, not what to do about it.
- No emoji, no generic filler.`;

function fmtPrompt(facts) {
  const lines = [
    `Ticker: ${facts.ticker} (${facts.name})`,
    `Sector: ${facts.sector || "unknown"}${facts.industry ? ` — ${facts.industry}` : ""}`,
  ];
  if (facts.businessSummary) lines.push(`Business summary: ${facts.businessSummary}`);
  else lines.push(`Business summary: none available from Yahoo for this ticker.`);

  if (facts.competitors.length) {
    lines.push(`Similar/competitor companies: ${facts.competitors.map((c) => `${c.ticker} (${c.name})`).join(", ")}`);
  } else {
    lines.push(`Similar/competitor companies: none on file.`);
  }

  if (facts.recommendationKey) {
    lines.push(
      `Analyst rating: ${facts.recommendationLabel} (mean score ${facts.recommendationMean ?? "n/a"} on a 1=strong buy...5=sell scale), from ${facts.numberOfAnalystOpinions ?? "an unknown number of"} analysts.`
    );
  } else {
    lines.push(`Analyst rating: no analyst coverage on file.`);
  }
  if (facts.targetMeanPrice != null) {
    lines.push(
      `Price target: mean $${facts.targetMeanPrice} (range $${facts.targetLowPrice}-$${facts.targetHighPrice}) vs. current price $${facts.price} — ${facts.analystUpsidePct != null ? `${facts.analystUpsidePct}% ${facts.analystUpsidePct >= 0 ? "upside" : "downside"}` : "upside unknown"}.`
    );
  }
  return lines.join("\n");
}

/**
 * The live Yahoo work for one ticker: the same 3-module quoteSummary
 * lib/stockIdeas.js already pulls (price/assetProfile/financialData) plus
 * summaryDetail for the 52-week range/PE/yield, and a fresh
 * recommendationsBySymbol call scoped to just this ticker for competitors.
 * Each piece degrades independently — a failed competitor lookup or a
 * ticker with no analyst coverage still returns a usable facts object,
 * matching this file's own "never a blank panel" rule; only a totally
 * failed quoteSummary for the ticker itself (bad symbol, Yahoo down) is
 * fatal, since there's nothing left to build a panel from at that point.
 */
async function fetchLiveDetail(ticker) {
  const quoteSummary = await yahoo.quoteSummary(ticker, {
    modules: ["price", "assetProfile", "summaryDetail", "financialData"],
  });

  let competitorQuotes = [];
  try {
    const rec = await yahoo.recommendationsBySymbol(ticker);
    const symbols = (Array.isArray(rec) ? rec[0] : rec)?.recommendedSymbols
      ?.map((s) => s.symbol)
      .filter(Boolean)
      .slice(0, 5) || [];
    if (symbols.length) {
      const quotes = await yahoo.quote(symbols);
      competitorQuotes = Array.isArray(quotes) ? quotes : [quotes];
    }
  } catch (err) {
    log.warn(`competitor lookup failed for ${ticker}: ${err.message}`);
  }

  return buildFacts({ ticker, quoteSummary, competitorQuotes });
}

/**
 * Pure: is a cached entry still good for `today`? The entire "don't use
 * yesterday's info" guarantee comes down to this one comparison — a
 * same-ticker recurrence 11+ days later (once stockIdeaNoRepeatDays lapses)
 * has a DIFFERENT `day` stamped on it than a cache entry from that earlier
 * pick, so it's never mistaken for a hit. `cached` is whatever
 * `all[ticker]` happens to be (undefined on a first-ever click), so this
 * also doubles as the "nothing cached yet" check.
 */
export function isFresh(cached, today) {
  return Boolean(cached && cached.day === today);
}

/** Pure: drop every entry not stamped with `today`, keeping today's map from
 *  quietly accumulating a growing tail of past days' picks forever. */
export function pruneToDay(all, today) {
  return Object.fromEntries(Object.entries(all || {}).filter(([, v]) => v.day === today));
}

/**
 * `getMeta("stockIdeaDetails")` is a small map keyed by ticker, each entry
 * stamped with the local calendar day it was fetched on. Any entry whose
 * day doesn't match today (in `config.timezone`) is treated as a miss and
 * dropped on the next write — self-pruning, so this never grows unbounded
 * across months of daily picks. `force` bypasses the cache entirely (used
 * by the matching refresh-stock-idea-detail.js script, same pattern as
 * every other force-refresh script in this app).
 */
export async function getStockIdeaDetail(config, ticker, { force = false } = {}) {
  const tz = config.timezone || "America/Toronto";
  const today = localDateKey(new Date(), tz);

  const all = (await getMeta("stockIdeaDetails", {})) || {};
  const cached = all[ticker];
  if (!force && isFresh(cached, today)) return cached;

  const facts = await fetchLiveDetail(ticker);

  const key = cacheKey("stock-idea-detail", { ticker, day: today });
  const parsed = await ask({
    system: SYSTEM,
    user: fmtPrompt(facts),
    config,
    maxTokens: 420,
    json: true,
    cacheAs: key,
  });

  let aiOut = null;
  if (parsed && typeof parsed.business === "string" && parsed.business.trim()) {
    aiOut = {
      business: parsed.business.trim().slice(0, 900),
      competitive: typeof parsed.competitive === "string" ? parsed.competitive.trim().slice(0, 700) : null,
      analysts: typeof parsed.analysts === "string" ? parsed.analysts.trim().slice(0, 700) : null,
    };
  }

  const result = { ticker, day: today, at: new Date().toISOString(), facts, ai: aiOut };

  // Prune every other day's entries as part of this write — the only time
  // this map is touched at all, so this is the one place staleness could
  // otherwise quietly accumulate.
  const pruned = pruneToDay(all, today);
  pruned[ticker] = result;
  await setMeta("stockIdeaDetails", pruned);

  log.info(`stock idea detail refreshed: ${ticker}`);
  return result;
}
