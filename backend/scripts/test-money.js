// scripts/test-money.js — the valuation math, which used to be wrong.
//
// Run: node scripts/test-money.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { valueBook, marketStatusLabel, currencyExposure, holdingsFromVault, isPlausibleFxRate } from "../sources/money.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
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

group("isPlausibleFxRate — a bad FX quote must never silently multiply every holding in that currency");

// Reported by Jon (2026-09-01): "it inflates all my holdings overnight."
// A stock quote going bad only affects one position and is already flagged
// (stale/unavailable); a bad FX rate multiplies EVERY position in that
// currency, with nothing in the old code to catch it — any positive number
// was trusted outright.

test("a small, realistic day-to-day move is accepted", () => {
  assert.equal(isPlausibleFxRate(1.39, 1.38), true);   // USD/CAD ticking up a cent
  assert.equal(isPlausibleFxRate(1.36, 1.38), true);   // or down
});

test("a implausible jump from the last known-good rate is rejected", () => {
  assert.equal(isPlausibleFxRate(138, 1.38), false);    // a decimal-place slip
  assert.equal(isPlausibleFxRate(0.0138, 1.38), false); // the inverse rate by mistake
  assert.equal(isPlausibleFxRate(1.9, 1.38), false);    // >15% in one pull, no real FX pair does this
});

test("zero or negative is always rejected outright, cache or no cache", () => {
  assert.equal(isPlausibleFxRate(0, 1.38), false);
  assert.equal(isPlausibleFxRate(-1.38, 1.38), false);
  assert.equal(isPlausibleFxRate(0, null), false);
});

test("with nothing cached yet for this currency, any positive rate is accepted — there's nothing to compare against", () => {
  assert.equal(isPlausibleFxRate(1.38, null), true);
  assert.equal(isPlausibleFxRate(0.0001, null), true);
});

test("the tolerance is configurable, for a currency that's genuinely more volatile", () => {
  assert.equal(isPlausibleFxRate(1.7, 1.38, 0.3), true);   // ~23% move, within a wider 30% band
  assert.equal(isPlausibleFxRate(1.7, 1.38, 0.1), false);  // same move, too much for a tighter 10% band
});

group("holdingsFromVault — a Syncthing conflict copy must never reach the holdings table");

// A real incident (2026-08-31): Syncthing left "ASML.TO.sync-conflict-
// 20260831-182831-4O2AEP5.md" next to "ASML.TO.md" after an edit landed on
// two devices at once. Both are valid `type: holding` notes with the same
// ticker, so the vault walk picked up both and the second INSERT into
// `holdings` (ticker is a PRIMARY KEY, see lib/db.js) threw a raw "UNIQUE
// constraint failed: holdings.ticker" that took the whole money pull down —
// the Sources panel showed that SQLite string verbatim with no indication
// it was a sync conflict, not a real duplicate.
async function withVault(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-secretary-test-vault-"));
  const savedEnv = process.env.VAULT_PATH;
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, "utf-8");
    }
    process.env.VAULT_PATH = dir;
    await fn(dir);
  } finally {
    if (savedEnv === undefined) delete process.env.VAULT_PATH;
    else process.env.VAULT_PATH = savedEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const note = (ticker, shares = 10, extra = "") => `---
type: holding
ticker: ${ticker}
currency: CAD
shares: ${shares}
${extra}---
`;

await atest("a Syncthing conflict copy of a real holding is skipped, not treated as a second position", async () => {
  await withVault({
    "ASML.TO.md": note("ASML.TO"),
    "ASML.TO.sync-conflict-20260831-182831-4O2AEP5.md": note("ASML.TO"),
    "CCO.TO.md": note("CCO.TO", 29.5538),
  }, async () => {
    const holdings = await holdingsFromVault({ money: { holdingsFolder: "." } });
    assert.deepEqual(holdings.map((h) => h.ticker).sort(), ["ASML.TO", "CCO.TO"]);
  });
});

await atest("two genuinely different notes claiming the same ticker still fail loudly, with a message that names both files", async () => {
  await withVault({
    "ASML-old.md": note("ASML.TO"),
    "ASML-new.md": note("ASML.TO"),
  }, async () => {
    await assert.rejects(
      () => holdingsFromVault({ money: { holdingsFolder: "." } }),
      (err) => {
        assert.match(err.message, /duplicate ticker "ASML\.TO"/);
        assert.match(err.message, /ASML-old\.md/);
        assert.match(err.message, /ASML-new\.md/);
        return true;
      }
    );
  });
});

await atest("a normal vault with no conflicts is unaffected", async () => {
  await withVault({
    "AMD.md": note("AMD", 3),
    "CCO.TO.md": note("CCO.TO", 29.5538),
  }, async () => {
    const holdings = await holdingsFromVault({ money: { holdingsFolder: "." } });
    assert.deepEqual(holdings.map((h) => h.ticker).sort(), ["AMD", "CCO.TO"]);
  });
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
