// scripts/test-stock-idea-detail.js — lib/stockIdeaDetail.js's pure logic:
// deterministic fact assembly from raw Yahoo quoteSummary/quote shapes
// (always present, no AI, degrades field-by-field rather than crashing),
// recommendation-key labeling, and the day-boundary cache rules that are
// this feature's whole point — a cached entry from an earlier day must
// never be mistaken for today's, even for a ticker that recurs.
//
// No real network call, no real AI call, no real store — buildFacts/
// recommendationLabel/isFresh/pruneToDay are all pure functions, tested the
// same way lib/stockIdeas.js's own pure helpers are in test-stock-ideas.js.
// The live Yahoo + AI integration (fetchLiveDetail/getTickerDetail's own
// network calls) is exercised by hand via
// `npm run refresh-stock-idea-detail`, same as lib/stockIdeas.js's
// refreshStockIdea/getStockIdea are — this codebase doesn't unit-test past
// the edge of a live third-party call.
//
// Run: node scripts/test-stock-idea-detail.js

import assert from "node:assert/strict";
import { buildFacts, recommendationLabel, isFresh, pruneToDay } from "../lib/stockIdeaDetail.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("recommendationLabel — Yahoo's recommendationKey to a plain label");

test("known keys map to their Title Case label", () => {
  assert.equal(recommendationLabel("strong_buy"), "Strong buy");
  assert.equal(recommendationLabel("buy"), "Buy");
  assert.equal(recommendationLabel("hold"), "Hold");
  assert.equal(recommendationLabel("underperform"), "Underperform");
  assert.equal(recommendationLabel("sell"), "Sell");
});

test("an unrecognized key still gets a readable label rather than the raw snake_case", () => {
  assert.equal(recommendationLabel("some_new_key"), "Some new key");
});

test("null/undefined/empty all come back null, not a crash", () => {
  assert.equal(recommendationLabel(null), null);
  assert.equal(recommendationLabel(undefined), null);
  assert.equal(recommendationLabel(""), null);
});

group("buildFacts — deterministic, degrades field-by-field, never crashes");

const fullQuoteSummary = {
  price: { shortName: "Widget Co", regularMarketPrice: 41.2, currency: "USD", marketCap: 4_200_000_000 },
  assetProfile: {
    sector: "Technology", industry: "Software", website: "https://widget.example",
    fullTimeEmployees: 1200, longBusinessSummary: "Widget Co makes widgets. It sells them worldwide.",
  },
  summaryDetail: { trailingPE: 18.4, fiftyTwoWeekLow: 22.1, fiftyTwoWeekHigh: 48.9, dividendYield: 0.012, marketCap: 4_200_000_000 },
  financialData: {
    currentPrice: 41.2, targetMeanPrice: 50, targetHighPrice: 60, targetLowPrice: 42,
    recommendationKey: "buy", recommendationMean: 2.1, numberOfAnalystOpinions: 14,
  },
};
const competitorQuotes = [
  { symbol: "RIVL", shortName: "Rival Inc", regularMarketPrice: 30, currency: "USD" },
  { symbol: "PEER", longName: "Peer Corp", regularMarketPrice: 55.5, currency: "USD" },
];

test("a fully-populated quoteSummary produces every field, dividend yield converted to a percent", () => {
  const f = buildFacts({ ticker: "WDGT", quoteSummary: fullQuoteSummary, competitorQuotes });
  assert.equal(f.ticker, "WDGT");
  assert.equal(f.name, "Widget Co");
  assert.equal(f.price, 41.2);
  assert.equal(f.currency, "USD");
  assert.equal(f.sector, "Technology");
  assert.equal(f.industry, "Software");
  assert.equal(f.website, "https://widget.example");
  assert.equal(f.employees, 1200);
  assert.equal(f.marketCap, 4_200_000_000);
  assert.equal(f.businessSummary, "Widget Co makes widgets. It sells them worldwide.");
  assert.equal(f.yahooUrl, "https://finance.yahoo.com/quote/WDGT");
  assert.equal(f.trailingPE, 18.4);
  assert.equal(f.fiftyTwoWeekLow, 22.1);
  assert.equal(f.fiftyTwoWeekHigh, 48.9);
  assert.equal(f.dividendYieldPct, 1.2);
  assert.equal(f.recommendationKey, "buy");
  assert.equal(f.recommendationLabel, "Buy");
  assert.equal(f.recommendationMean, 2.1);
  assert.equal(f.numberOfAnalystOpinions, 14);
  assert.equal(f.targetMeanPrice, 50);
  // (50 - 41.2) / 41.2 * 100 = 21.4...
  assert.equal(f.analystUpsidePct, 21.4);
});

test("competitors carry through with a name fallback (shortName, then longName, then the bare symbol)", () => {
  const f = buildFacts({
    ticker: "WDGT", quoteSummary: fullQuoteSummary,
    competitorQuotes: [...competitorQuotes, { symbol: "BARE", regularMarketPrice: 10, currency: "USD" }],
  });
  assert.deepEqual(f.competitors.map((c) => c.name), ["Rival Inc", "Peer Corp", "BARE"]);
  assert.equal(f.competitors[0].ticker, "RIVL");
  assert.equal(f.competitors[0].price, 30);
});

test("no competitors at all is an empty array, not null or a crash", () => {
  const f = buildFacts({ ticker: "WDGT", quoteSummary: fullQuoteSummary, competitorQuotes: [] });
  assert.deepEqual(f.competitors, []);
  const f2 = buildFacts({ ticker: "WDGT", quoteSummary: fullQuoteSummary, competitorQuotes: undefined });
  assert.deepEqual(f2.competitors, []);
});

test("a quoteSummary missing assetProfile/financialData/summaryDetail entirely still produces a usable facts object", () => {
  const f = buildFacts({
    ticker: "BARE", quoteSummary: { price: { regularMarketPrice: 9.5, currency: "CAD" } },
    competitorQuotes: [],
  });
  assert.equal(f.name, "BARE"); // falls back to the ticker itself with no shortName/longName
  assert.equal(f.price, 9.5);
  assert.equal(f.sector, null);
  assert.equal(f.businessSummary, null);
  assert.equal(f.recommendationKey, null);
  assert.equal(f.recommendationLabel, null);
  assert.equal(f.targetMeanPrice, null);
  assert.equal(f.analystUpsidePct, null); // no target price to compare against
  assert.equal(f.dividendYieldPct, null);
});

test("no analyst coverage (recommendationKey present with no target price) still reads as a real 'no upside data' case, not a crash", () => {
  const f = buildFacts({
    ticker: "WDGT",
    quoteSummary: { ...fullQuoteSummary, financialData: { recommendationKey: "hold", currentPrice: 41.2 } },
    competitorQuotes: [],
  });
  assert.equal(f.recommendationLabel, "Hold");
  assert.equal(f.targetMeanPrice, null);
  assert.equal(f.analystUpsidePct, null);
});

test("an overlong business summary is capped at 4000 chars rather than blowing out the panel", () => {
  const f = buildFacts({
    ticker: "WDGT",
    quoteSummary: { ...fullQuoteSummary, assetProfile: { ...fullQuoteSummary.assetProfile, longBusinessSummary: "x".repeat(5000) } },
    competitorQuotes: [],
  });
  assert.equal(f.businessSummary.length, 4000);
});

group("isFresh / pruneToDay — the day-boundary cache rules");

test("a cache entry stamped with today is a hit", () => {
  assert.equal(isFresh({ day: "2026-08-28" }, "2026-08-28"), true);
});

test("a cache entry stamped with any other day is a miss — including a SAME ticker recurring after the no-repeat window lapses", () => {
  assert.equal(isFresh({ day: "2026-08-17" }, "2026-08-28"), false);
});

test("no cached entry at all (undefined — a first-ever click) is a miss, not a crash", () => {
  assert.equal(isFresh(undefined, "2026-08-28"), false);
});

test("pruneToDay drops every entry not stamped with today, keeps the rest", () => {
  const all = {
    AAA: { day: "2026-08-27", ticker: "AAA" },
    BBB: { day: "2026-08-28", ticker: "BBB" },
    CCC: { day: "2026-08-01", ticker: "CCC" },
  };
  const pruned = pruneToDay(all, "2026-08-28");
  assert.deepEqual(Object.keys(pruned), ["BBB"]);
});

test("pruneToDay on an empty/undefined map is just an empty map, not a crash", () => {
  assert.deepEqual(pruneToDay({}, "2026-08-28"), {});
  assert.deepEqual(pruneToDay(undefined, "2026-08-28"), {});
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
