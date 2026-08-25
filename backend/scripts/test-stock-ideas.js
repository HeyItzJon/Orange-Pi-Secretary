// scripts/test-stock-ideas.js — the pure ranking/bucket math behind the
// money page's "worth a look" candidate. No network calls here; the Yahoo
// side (refreshStockIdea, getStockIdea) is exercised manually via
// `npm run refresh-stock-idea` against real data instead — see the README.
//
// Run: node scripts/test-stock-ideas.js

import assert from "node:assert/strict";
import { sectorBucket, sectorWeights, rankCandidates, firstSentences } from "../lib/stockIdeas.js";

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

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
