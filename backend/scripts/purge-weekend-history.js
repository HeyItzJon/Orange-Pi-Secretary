// scripts/purge-weekend-history.js
//
// One-off cleanup for rows that predate the Round 49 fix in
// sources/money.js: before that fix, collectMoney() ran on its normal
// 15-minute schedule seven days a week with no check for whether the
// market was actually open, so a Saturday/Sunday poll recomputed dayPct
// from Yahoo's frozen (unchanged-since-Friday) quote data and wrote it to
// portfolio_days/holding_days as if it were real. The fix stops that from
// happening going forward — a day nothing traded now gets no row at all,
// which the year grid already renders as "nodata" (grey) — but it can't
// retroactively fix rows that were already written before the fix went
// live. This is that retroactive fix, run once.
//
// Scoped to weekends specifically (Saturday/Sunday), not "any closed
// day": a weekend is knowable with zero ambiguity from the date alone,
// unlike a market holiday, which needs an actual calendar to identify
// after the fact. No exchange holiday has occurred since tracking started
// (the first one, Labor Day, is still ahead as of this writing), so
// there's nothing to retroactively catch there yet — if one ever slips
// through before a future fix, it'll need its own one-off pass the same
// way this one does.
//
// Safe to re-run: rows already gone just don't match a second time.
//
// Run:
//   node scripts/purge-weekend-history.js --dry-run     preview only
//   node scripts/purge-weekend-history.js               actually deletes

import "dotenv/config";

const dryRun = process.argv.includes("--dry-run");

const { getDb } = await import("../lib/db.js");
const dbc = getDb();

function isWeekend(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6; // Sunday, Saturday
}

const portfolioRows = dbc.prepare("SELECT date, dayPct FROM portfolio_days ORDER BY date").all();
const holdingRows = dbc.prepare("SELECT date, ticker, dayChangePct FROM holding_days ORDER BY date, ticker").all();

const badPortfolioDays = portfolioRows.filter((r) => isWeekend(r.date));
const badHoldingDays = holdingRows.filter((r) => isWeekend(r.date));

if (!badPortfolioDays.length && !badHoldingDays.length) {
  console.log("\nNo weekend rows found in portfolio_days or holding_days — nothing to clean up.");
  process.exit(0);
}

if (badPortfolioDays.length) {
  console.log(`\n${badPortfolioDays.length} portfolio_days row(s) to delete (weekend dates with a fabricated dayPct):\n`);
  for (const r of badPortfolioDays) console.log(`  - ${r.date}  dayPct=${r.dayPct}`);
}
if (badHoldingDays.length) {
  console.log(`\n${badHoldingDays.length} holding_days row(s) to delete:\n`);
  for (const r of badHoldingDays) console.log(`  - ${r.date}  ${r.ticker}  dayChangePct=${r.dayChangePct}`);
}

if (!dryRun) {
  const delPortfolio = dbc.prepare("DELETE FROM portfolio_days WHERE date = ?");
  const delHolding = dbc.prepare("DELETE FROM holding_days WHERE date = ?");
  const uniqueDates = new Set([...badPortfolioDays.map((r) => r.date), ...badHoldingDays.map((r) => r.date)]);
  for (const date of uniqueDates) {
    delPortfolio.run(date);
    delHolding.run(date);
  }
}

console.log(
  dryRun
    ? `\nDry run — nothing changed. Re-run without --dry-run to actually delete these rows.`
    : `\nDeleted ${badPortfolioDays.length} portfolio_days row(s) and ${badHoldingDays.length} holding_days row(s). Those dates will render as "nodata" (grey) on the year grid from now on.`
);
