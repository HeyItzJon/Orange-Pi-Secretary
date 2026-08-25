// scripts/test-stock-ideas.js — the pure ranking/bucket math behind the
// money page's "worth a look" candidate. No network calls here; the Yahoo
// side (refreshStockIdea, getStockIdea) is exercised manually via
// `npm run refresh-stock-idea` against real data instead — see the README.
//
// Run: node scripts/test-stock-ideas.js

import assert from "node:assert/strict";
import {
  sectorBucket,
  sectorWeights,
  rankCandidates,
  firstSentences,
  analystUpsidePct,
  excludeRecent,
} from "../lib/stockIdeas.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("sectorBucket — collapsing the vault's granular labels to a broad bucket");

test("takes the text before ' - '", () => {
  assert.equal(sectorBucket("Technology - Fintech"), "Technology");
  assert.equal(sectorBucket("Industrials - Aerospace"), "Industrials");
});

test("a label with no ' - ' passes through unchanged", () => {
  assert.equal(sectorBucket("Healthcare"), "Healthcare");
});

test("known aliases normalise toward Yahoo's own naming", () => {
  assert.equal(sectorBucket("Financials - Banks"), "Financial Services");
});

test("missing sector is null, never a guessed bucket", () => {
  assert.equal(sectorBucket(null), null);
  assert.equal(sectorBucket(undefined), null);
  assert.equal(sectorBucket(""), null);
});

group("sectorWeights — real weightPct from real positions, nothing invented");

test("sums weightPct per bucket across positions", () => {
  const w = sectorWeights([
    { sector: "Technology - Fintech", weightPct: 10, value: 100 },
    { sector: "Technology - Semiconductors", weightPct: 8, value: 80 },
    { sector: "Healthcare - Biotech", weightPct: 2, value: 20 },
  ]);
  assert.equal(w.Technology, 18);
  assert.equal(w.Healthcare, 2);
});

test("a position with no priced value is skipped, not counted as zero-weight", () => {
  const w = sectorWeights([
    { sector: "Technology", weightPct: 10, value: 100 },
    { sector: "Energy", weightPct: null, value: null },
  ]);
  assert.deepEqual(Object.keys(w), ["Technology"]);
});

test("a position with no sector at all is skipped, not bucketed as 'null'", () => {
  const w = sectorWeights([{ sector: null, weightPct: 5, value: 50 }]);
  assert.deepEqual(w, {});
});

test("empty or missing positions list returns an empty weight map, not a crash", () => {
  assert.deepEqual(sectorWeights([]), {});
  assert.deepEqual(sectorWeights(undefined), {});
});

group("rankCandidates — similarity first, discounted by how heavy that sector already is");

test("a candidate in an empty sector outranks an equally-similar one in a heavy sector", () => {
  const ranked = rankCandidates(
    [
      { symbol: "THIN", sector: "Healthcare", aggScore: 0.5, mentions: 2 },
      { symbol: "HEAVY", sector: "Technology", aggScore: 0.5, mentions: 2 },
    ],
    { Technology: 60, Healthcare: 0 }
  );
  assert.deepEqual(ranked.map((c) => c.symbol), ["THIN", "HEAVY"]);
});

test("concentrationPenalty: 0 ignores sector weight entirely — ranks purely on aggScore", () => {
  const ranked = rankCandidates(
    [
      { symbol: "A", sector: "Technology", aggScore: 0.4, mentions: 1 },
      { symbol: "B", sector: "Technology", aggScore: 0.9, mentions: 1 },
    ],
    { Technology: 90 },
    { concentrationPenalty: 0 }
  );
  assert.deepEqual(ranked.map((c) => c.symbol), ["B", "A"]);
  assert.equal(ranked[0].rebalanceScore, ranked[0].aggScore);
});

test("a candidate with no sector data gets no concentration discount either way", () => {
  const ranked = rankCandidates(
    [{ symbol: "NOSECTOR", sector: null, aggScore: 0.3, mentions: 1 }],
    { Technology: 90 }
  );
  assert.equal(ranked[0].rebalanceScore, ranked[0].aggScore);
  assert.equal(ranked[0].currentSectorWeightPct, 0);
});

test("the reason string names how many holdings it echoes and the thin sector it fills", () => {
  const ranked = rankCandidates(
    [{ symbol: "X", sector: "Healthcare - Biotech", aggScore: 0.6, mentions: 3 }],
    { Healthcare: 1.2 }
  );
  assert.match(ranked[0].reason, /similar to 3 of your holdings/);
  assert.match(ranked[0].reason, /Healthcare is only 1% of your book/);
});

test("a single-mention candidate reads as singular, not '1 of your holdings'", () => {
  const ranked = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.6, mentions: 1 }],
    {}
  );
  assert.match(ranked[0].reason, /similar to a holding you own/);
});

test("a sector already at or above 3% weight is named plainly, not called 'thin'", () => {
  const ranked = rankCandidates(
    [{ symbol: "X", sector: "Technology", aggScore: 0.6, mentions: 2 }],
    { Technology: 25 }
  );
  assert.match(ranked[0].reason, /Technology/);
  assert.doesNotMatch(ranked[0].reason, /only \d+% of your book/);
});

group("firstSentences — Yahoo's own business-summary text, just less of it");

test("takes the first N sentences, joined with a space", () => {
  const text = "Widgets Inc makes widgets. It was founded in 1999. It is headquartered in Reno.";
  assert.equal(firstSentences(text, { sentences: 2 }), "Widgets Inc makes widgets. It was founded in 1999.");
});

test("shorter than the sentence count just returns the whole (trimmed) text", () => {
  assert.equal(firstSentences("One sentence only."), "One sentence only.");
});

test("null, undefined, and empty string all come back null, not an empty string", () => {
  assert.equal(firstSentences(null), null);
  assert.equal(firstSentences(undefined), null);
  assert.equal(firstSentences(""), null);
  assert.equal(firstSentences("   "), null);
});

test("a result longer than maxChars is truncated at a word boundary with an ellipsis", () => {
  const long = "A".repeat(50) + " " + "B".repeat(200) + ".";
  const out = firstSentences(long, { sentences: 1, maxChars: 60 });
  assert.ok(out.length <= 61, `expected <=61 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
});

test("a text with no sentence-ending punctuation at all still comes back, not dropped", () => {
  assert.equal(firstSentences("no punctuation here at all"), "no punctuation here at all");
});

group("analystUpsidePct — how far the live price sits below Yahoo's analyst target");

test("target above price is positive upside", () => {
  assert.equal(analystUpsidePct(100, 120), 20);
});

test("target below price is negative (downside)", () => {
  assert.equal(analystUpsidePct(100, 80), -20);
});

test("missing price or missing target is null, not a NaN or a guess", () => {
  assert.equal(analystUpsidePct(null, 120), null);
  assert.equal(analystUpsidePct(100, null), null);
  assert.equal(analystUpsidePct(undefined, undefined), null);
});

test("a zero or negative price is null rather than dividing by it", () => {
  assert.equal(analystUpsidePct(0, 120), null);
  assert.equal(analystUpsidePct(-5, 120), null);
});

group("excludeRecent — keeping a static portfolio from re-deriving yesterday's pick");

test("drops any candidate whose symbol is in the recent list", () => {
  const out = excludeRecent(
    [{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }],
    ["BBB"]
  );
  assert.deepEqual(out.map((c) => c.symbol), ["AAA", "CCC"]);
});

test("an empty recent list is a no-op", () => {
  const candidates = [{ symbol: "AAA" }, { symbol: "BBB" }];
  assert.deepEqual(excludeRecent(candidates, []), candidates);
});

test("a missing/undefined recent list is also a no-op, not a crash", () => {
  const candidates = [{ symbol: "AAA" }];
  assert.deepEqual(excludeRecent(candidates, undefined), candidates);
});

group("rankCandidates — analyst upside, layered on top of the sector-concentration score");

test("analystUpsideWeight: 0 (the default) ignores analyst data entirely", () => {
  const ranked = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: 40 }],
    {}
  );
  assert.equal(ranked[0].rebalanceScore, ranked[0].aggScore);
});

test("positive upside raises the score above the no-upside baseline, negative lowers it", () => {
  const base = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: 0 }],
    {},
    { analystUpsideWeight: 0.5 }
  )[0].rebalanceScore;
  const up = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: 20 }],
    {},
    { analystUpsideWeight: 0.5 }
  )[0].rebalanceScore;
  const down = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: -20 }],
    {},
    { analystUpsideWeight: 0.5 }
  )[0].rebalanceScore;
  assert.ok(up > base, `expected upside score ${up} > baseline ${base}`);
  assert.ok(down < base, `expected downside score ${down} < baseline ${base}`);
});

test("upside is clamped to +60/-30 so one outlier target can't dominate", () => {
  const extreme = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 1, mentions: 1, analystUpsidePct: 500 }],
    {},
    { analystUpsideWeight: 1 }
  )[0].rebalanceScore;
  const atCap = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 1, mentions: 1, analystUpsidePct: 60 }],
    {},
    { analystUpsideWeight: 1 }
  )[0].rebalanceScore;
  assert.equal(extreme, atCap);

  const extremeDown = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 1, mentions: 1, analystUpsidePct: -500 }],
    {},
    { analystUpsideWeight: 1 }
  )[0].rebalanceScore;
  const atFloor = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 1, mentions: 1, analystUpsidePct: -30 }],
    {},
    { analystUpsideWeight: 1 }
  )[0].rebalanceScore;
  assert.equal(extremeDown, atFloor);
});

test("a candidate with no analyst data at all is neutral, not penalized", () => {
  const withNull = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: null }],
    {},
    { analystUpsideWeight: 0.5 }
  )[0].rebalanceScore;
  const withZero = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: 0 }],
    {},
    { analystUpsideWeight: 0.5 }
  )[0].rebalanceScore;
  assert.equal(withNull, withZero);
});

test("the reason string names the upside or downside when analyst data is present", () => {
  const up = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: 22 }],
    {}
  )[0];
  assert.match(up.reason, /analysts see 22% upside/);

  const down = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: -15 }],
    {}
  )[0];
  assert.match(down.reason, /analysts see 15% downside/);
});

test("a candidate with no analyst data omits the upside/downside clause entirely", () => {
  const ranked = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 0.5, mentions: 1, analystUpsidePct: null }],
    {}
  );
  assert.doesNotMatch(ranked[0].reason, /analysts see/);
});

test("mentions: 0 falls back to the discoveredVia text — the 'beyond your portfolio' source", () => {
  const withSource = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 1, mentions: 0, discoveredVia: "surfaced by Yahoo's aggressive small caps screen" }],
    {}
  )[0];
  assert.match(withSource.reason, /surfaced by Yahoo's aggressive small caps screen/);

  const noSource = rankCandidates(
    [{ symbol: "X", sector: null, aggScore: 1, mentions: 0, discoveredVia: null }],
    {}
  )[0];
  assert.match(noSource.reason, /surfaced by Yahoo's small-cap screener/);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
