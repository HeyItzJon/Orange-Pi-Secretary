// scripts/test-money.js — the valuation math, which used to be wrong.
//
// Run: node scripts/test-money.js

import assert from "node:assert/strict";
import { valueBook, marketStatusLabel, currencyExposure } from "../sources/money.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}
const near = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) < tol, `expected ~${b}, got ${a}`);

// Real shapes: AMD is priced in USD, Cameco in CAD, on the same statement.
const FX = { CAD: 1, USD: 1.38 };
const ROWS = [
  { ticker: "AMD",    shares: 3,       price: 485.39, currency: "USD", dayChangePct: 2,  bookValue: 279.42 },
  { ticker: "CCO.TO", shares: 29.5538, price: 123.56, currency: "CAD", dayChangePct: -1, bookValue: 3176.34 },
];

group("currency — the bug this file exists for");

test("USD positions are converted before they are summed", () => {
  const { total } = valueBook(ROWS, FX, "CAD");
  // 3 × 485.39 × 1.38 = 2009.51   +   29.5538 × 123.56 = 3651.47
  near(total, 2009.5146 + 3651.6674, 0.05);
});

test("the old mixed-currency sum is provably a different, smaller number", () => {
  const { total } = valueBook(ROWS, FX, "CAD");
  const naive = ROWS.reduce((s, r) => s + r.price * r.shares, 0);   // the old line
  assert.ok(total > naive, "converting must raise the total, not leave it alone");
  near(total - naive, 3 * 485.39 * 0.38, 0.05);   // exactly the FX uplift on AMD
});

test("weights are computed after conversion, so the biggest position is the real one", () => {
  const { positions } = valueBook(ROWS, FX, "CAD");
  const amd = positions.find((p) => p.ticker === "AMD");
  const cco = positions.find((p) => p.ticker === "CCO.TO");
  near(amd.weightPct + cco.weightPct, 100, 0.01);
  assert.ok(cco.weightPct > amd.weightPct, "Cameco is the larger holding once both are in CAD");
});

test("positions come back biggest first", () => {
  const { positions } = valueBook(ROWS, FX, "CAD");
  assert.deepEqual(positions.map((p) => p.ticker), ["CCO.TO", "AMD"]);
});

test("a currency with no rate is excluded from the total rather than counted raw", () => {
  const rows = [...ROWS, { ticker: "ASML.AS", shares: 2, price: 700, currency: "EUR", dayChangePct: 0 }];
  const { total, positions } = valueBook(rows, FX, "CAD");   // no EUR rate
  near(total, 2009.5146 + 3651.6674, 0.05);
  assert.equal(positions.find((p) => p.ticker === "ASML.AS").value, null,
    "better a visible gap than a silently wrong number");
});

group("day change");

test("the day move is measured on the securities, not the currency", () => {
  // Same rate on both sides, so FX cannot contribute to the percentage.
  const { dayPct } = valueBook(ROWS, FX, "CAD");
  const amdPrev = (485.39 / 1.02) * 3 * 1.38;
  const ccoPrev = (123.56 / 0.99) * 29.5538;
  const prev = amdPrev + ccoPrev;
  const now = 2009.5146 + 3651.6674;
  near(dayPct, ((now - prev) / prev) * 100, 0.02);
});

test("a real previous close is preferred over back-calculating from the percent", () => {
  const rows = [{ ticker: "X", shares: 10, price: 110, currency: "CAD", dayChangePct: 10, prevClose: 100 }];
  const { dayPct } = valueBook(rows, { CAD: 1 }, "CAD");
  near(dayPct, 10, 0.001);
});

test("day change in dollars rides along, because percentages hide size", () => {
  const { positions } = valueBook(ROWS, FX, "CAD");
  const amd = positions.find((p) => p.ticker === "AMD");
  near(amd.dayChangeValue, amd.value - amd.value / 1.02, 0.01);
});

test("an empty book is zero, not NaN", () => {
  const { total, dayPct, positions } = valueBook([], FX, "CAD");
  assert.equal(total, 0);
  assert.equal(dayPct, 0);
  assert.deepEqual(positions, []);
});

group("book value and return");

test("book value is converted too, so total return isn't inflated by FX", () => {
  const { positions } = valueBook(ROWS, FX, "CAD");
  const amd = positions.find((p) => p.ticker === "AMD");
  near(amd.bookValue, 279.42 * 1.38, 0.01);
  // Both sides in CAD: the return is the same number you'd get in USD.
  near(amd.totalReturnPct, ((485.39 * 3 - 279.42) / 279.42) * 100, 0.01);
});

test("no book value means no return figure, rather than a fabricated one", () => {
  const rows = [{ ticker: "Y", shares: 1, price: 10, currency: "CAD", dayChangePct: 0 }];
  const { positions } = valueBook(rows, { CAD: 1 }, "CAD");
  assert.equal(positions[0].totalReturnPct, null);
});

group("prices that did not refresh");

test("a stale row still values, but carries the flag that says do not trust it", () => {
  const rows = [{ ticker: "Z", shares: 5, price: 20, currency: "CAD", dayChangePct: 1, stale: true }];
  const { total, positions } = valueBook(rows, { CAD: 1 }, "CAD");
  assert.equal(total, 100);
  assert.equal(positions[0].stale, true);
});

test("a row with no price at all contributes nothing and is marked unavailable", () => {
  const rows = [...ROWS, { ticker: "GONE", shares: 5, price: null, currency: "CAD", unavailable: true }];
  const { total, positions } = valueBook(rows, FX, "CAD");
  near(total, 2009.5146 + 3651.6674, 0.05);
  const gone = positions.find((p) => p.ticker === "GONE");
  assert.equal(gone.value, null);
  assert.equal(gone.weightPct, 0);
});

group("marketStatusLabel — one real label for the book, not whichever row came first");

test("both US and CAD positions in REGULAR hours: 'markets open'", () => {
  const rows = [
    { currency: "USD", marketState: "REGULAR" },
    { currency: "CAD", marketState: "REGULAR" },
  ];
  assert.equal(marketStatusLabel(rows), "markets open");
});

test("only the US book is in REGULAR hours: 'US markets open', not blended with TSX's state", () => {
  const rows = [
    { currency: "USD", marketState: "REGULAR" },
    { currency: "CAD", marketState: "CLOSED" },
  ];
  assert.equal(marketStatusLabel(rows), "US markets open");
});

test("only the TSX book is in REGULAR hours: 'TSX open'", () => {
  const rows = [
    { currency: "USD", marketState: "CLOSED" },
    { currency: "CAD", marketState: "REGULAR" },
  ];
  assert.equal(marketStatusLabel(rows), "TSX open");
});

test("this is the actual bug report: Yahoo's raw POSTPOST never reaches the label as-is", () => {
  const rows = [{ currency: "USD", marketState: "POSTPOST" }];
  assert.equal(marketStatusLabel(rows), "post-market");
});

test("PRE and PREPRE both read as pre-market", () => {
  assert.equal(marketStatusLabel([{ currency: "USD", marketState: "PRE" }]), "pre-market");
  assert.equal(marketStatusLabel([{ currency: "USD", marketState: "PREPRE" }]), "pre-market");
});

test("an open market always wins over a pre/post one elsewhere in the book", () => {
  const rows = [
    { currency: "USD", marketState: "POST" },
    { currency: "CAD", marketState: "REGULAR" },
  ];
  assert.equal(marketStatusLabel(rows), "TSX open");
});

test("everything closed, or no market data at all: null — nothing worth saying", () => {
  assert.equal(marketStatusLabel([{ currency: "USD", marketState: "CLOSED" }]), null);
  assert.equal(marketStatusLabel([]), null);
  assert.equal(marketStatusLabel([{ currency: "USD", marketState: null }]), null);
});

test("a currency outside USD/CAD still counts for open/pre/post, just without a market name", () => {
  assert.equal(marketStatusLabel([{ currency: "EUR", marketState: "REGULAR" }]), "markets open");
  assert.equal(marketStatusLabel([{ currency: "GBP", marketState: "PRE" }]), "pre-market");
});

group("currencyExposure — CAD/USD split, no fetch needed");

test("positions in the same currency combine into one slice", () => {
  const positions = [
    { ticker: "VFV", weightPct: 54, currency: "USD" },
    { ticker: "MSFT", weightPct: 7.6, currency: "USD" },
    { ticker: "XEQT", weightPct: 38.2, currency: "CAD" },
  ];
  const exp = currencyExposure(positions);
  const usd = exp.find((e) => e.currency === "USD");
  const cad = exp.find((e) => e.currency === "CAD");
  near(usd.pct, 61.6);
  near(cad.pct, 38.2);
});

test("comes back biggest currency first", () => {
  const positions = [{ ticker: "A", weightPct: 20, currency: "CAD" }, { ticker: "B", weightPct: 80, currency: "USD" }];
  assert.deepEqual(currencyExposure(positions).map((e) => e.currency), ["USD", "CAD"]);
});

test("a position with no weight or no currency is skipped, not counted as its own slice", () => {
  const positions = [
    { ticker: "A", weightPct: 100, currency: "CAD" },
    { ticker: "B", weightPct: 0, currency: "USD" },
    { ticker: "C", weightPct: 5, currency: null },
  ];
  assert.deepEqual(currencyExposure(positions), [{ currency: "CAD", pct: 100 }]);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
