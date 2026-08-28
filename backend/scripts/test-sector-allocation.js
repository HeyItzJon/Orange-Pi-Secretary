// scripts/test-sector-allocation.js — the look-through GICS sector pie's
// pure math: normalizing Yahoo's various spellings, turning one ticker's
// raw modules into a sector-fraction map, and weighting those by the
// book's own position weights.
//
// Run: node scripts/test-sector-allocation.js

import assert from "node:assert/strict";
import { toGicsSector, sectorsFromYahoo, buildAllocation } from "../lib/sectorAllocation.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}
const near = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) < tol, `expected ~${b}, got ${a}`);

group("toGicsSector — Yahoo's three spellings, one canonical name each");

test("an individual stock's plain Yahoo sector string maps to GICS", () => {
  assert.equal(toGicsSector("Technology"), "Information Technology");
  assert.equal(toGicsSector("Financial Services"), "Financials");
  assert.equal(toGicsSector("Consumer Cyclical"), "Consumer Discretionary");
  assert.equal(toGicsSector("Consumer Defensive"), "Consumer Staples");
  assert.equal(toGicsSector("Healthcare"), "Health Care");
});

test("a fund's snake_case sectorWeightings key maps to the same GICS name", () => {
  assert.equal(toGicsSector("technology"), "Information Technology");
  assert.equal(toGicsSector("financial_services"), "Financials");
  assert.equal(toGicsSector("consumer_cyclical"), "Consumer Discretionary");
  assert.equal(toGicsSector("realestate"), "Real Estate");
});

test("case and spacing don't matter", () => {
  assert.equal(toGicsSector("  REAL ESTATE  "), "Real Estate");
});

test("an unrecognized string is null, never guessed at", () => {
  assert.equal(toGicsSector("Cryptocurrency"), null);
  assert.equal(toGicsSector(null), null);
  assert.equal(toGicsSector(""), null);
});

group("sectorsFromYahoo — one ticker's raw modules into a fraction map");

test("a fund's sectorWeightings becomes a normalized multi-sector split", () => {
  const sectors = sectorsFromYahoo({
    topHoldings: {
      sectorWeightings: [
        { technology: 0.3 }, { financial_services: 0.15 }, { healthcare: 0.12 },
        { industrials: 0.1 }, { consumer_cyclical: 0.1 }, { energy: 0.05 },
        { consumer_defensive: 0.06 }, { utilities: 0.03 }, { realestate: 0.02 },
        { basic_materials: 0.02 }, { communication_services: 0.05 },
      ],
    },
  });
  near(Object.values(sectors).reduce((a, b) => a + b, 0), 1);
  near(sectors["Information Technology"], 0.3);
  near(sectors["Financials"], 0.15);
});

test("a fund summing to less than 1 (cash held aside) is renormalized to 1", () => {
  const sectors = sectorsFromYahoo({
    topHoldings: { sectorWeightings: [{ technology: 0.4 }, { healthcare: 0.2 }] },
  });
  near(Object.values(sectors).reduce((a, b) => a + b, 0), 1);
  near(sectors["Information Technology"], 0.4 / 0.6);
});

test("an individual stock with no fund data falls back to its single assetProfile sector", () => {
  const sectors = sectorsFromYahoo({ assetProfile: { sector: "Technology" } });
  assert.deepEqual(sectors, { "Information Technology": 1 });
});

test("neither module giving anything usable returns null, not an empty object", () => {
  assert.equal(sectorsFromYahoo({}), null);
  assert.equal(sectorsFromYahoo({ assetProfile: { sector: "Some New Thing" } }), null);
  assert.equal(sectorsFromYahoo({ topHoldings: { sectorWeightings: [] } }), null);
});

group("buildAllocation — the whole book's look-through mix");

test("an ETF's underlying sectors are weighted by its own share of the book, not lumped as 'ETF'", () => {
  const positions = [{ ticker: "VFV", weightPct: 80, sector: "ETF - US Equity" }];
  const profiles = { VFV: { sectors: { "Information Technology": 0.3, "Financials": 0.7 } } };
  const alloc = buildAllocation(positions, profiles);
  const byName = Object.fromEntries(alloc.map((s) => [s.sector, s.pct]));
  near(byName["Information Technology"], 24); // 80% * 0.3
  near(byName["Financials"], 56);             // 80% * 0.7
});

test("a stock and an ETF that both touch the same sector combine into one slice", () => {
  const positions = [
    { ticker: "VFV", weightPct: 80, sector: "ETF - US Equity" },
    { ticker: "MSFT", weightPct: 20, sector: "Technology" },
  ];
  const profiles = {
    VFV: { sectors: { "Information Technology": 0.3, "Financials": 0.7 } },
    MSFT: { sectors: { "Information Technology": 1 } },
  };
  const alloc = buildAllocation(positions, profiles);
  const tech = alloc.find((s) => s.sector === "Information Technology");
  near(tech.pct, 44); // 80%*0.3 + 20%*1
});

test("a ticker with no Yahoo profile falls back to its own vault sector tag, unmapped", () => {
  const positions = [{ ticker: "XEQT", weightPct: 38, sector: "ETF - All Equity" }];
  const alloc = buildAllocation(positions, { XEQT: { sectors: null } });
  assert.deepEqual(alloc, [{ sector: "ETF", pct: 38 }]); // sectorBucket() takes the text before " - "
});

test("a ticker with neither a Yahoo profile nor a vault sector tag lands in Unclassified, not dropped", () => {
  const positions = [{ ticker: "MYSTERY", weightPct: 5, sector: null }];
  const alloc = buildAllocation(positions, {});
  assert.deepEqual(alloc, [{ sector: "Unclassified", pct: 5 }]);
});

test("results come back biggest slice first", () => {
  const positions = [
    { ticker: "A", weightPct: 10, sector: "Energy" },
    { ticker: "B", weightPct: 60, sector: "Technology" },
  ];
  const profiles = { A: { sectors: { Energy: 1 } }, B: { sectors: { "Information Technology": 1 } } };
  const alloc = buildAllocation(positions, profiles);
  assert.deepEqual(alloc.map((s) => s.sector), ["Information Technology", "Energy"]);
});

test("a position with no weight (unpriced) is skipped, not treated as zero", () => {
  const positions = [{ ticker: "A", weightPct: 0, sector: "Energy" }, { ticker: "B", weightPct: 50, sector: "Technology" }];
  const profiles = { B: { sectors: { "Information Technology": 1 } } };
  const alloc = buildAllocation(positions, profiles);
  assert.equal(alloc.length, 1);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
