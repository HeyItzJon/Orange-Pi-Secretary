// scripts/refresh-stock-idea.js
//
// Force an immediate stock-idea refresh instead of waiting for the first
// pull after local midnight (config.money.stockIdeaRefreshDays, default 1
// — see lib/time.js). Prints the ranked candidate(s) and why each one
// surfaced — same output the money page reads, just without waiting.
//
// Run: node scripts/refresh-stock-idea.js

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, getHoldings, getMeta } from "../lib/store.js";
import { getStockIdea } from "../lib/stockIdeas.js";

function printDebug(debug) {
  if (!debug) { console.log("(no debug trail recorded — that's unexpected, worth flagging)"); return; }
  console.log(
    `  ${debug.tickerCount} tickers checked → ${debug.recCount} related symbols found → ` +
    `${debug.shortlistCount} shortlisted → ${debug.enrichedCount} enriched`
  );
  if (debug.note) console.log(`  stopped because: ${debug.note}`);
  if (debug.chunkErrors?.length) {
    console.log(`  errors along the way:`);
    for (const e of debug.chunkErrors) console.log(`    - ${e}`);
  }
  if (debug.noSummary?.length) {
    console.log(`  missing a business summary:`);
    for (const e of debug.noSummary) console.log(`    - ${e}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

const holdings = await getHoldings();
if (!holdings.length) {
  console.log("no holdings in the local table yet — run `npm run sync-holdings` first");
  process.exit(1);
}

// Real sector weights need real dollar values, not just share counts — use
// the positions from the last actual money pull (moneySummary.positions,
// the same array the money page itself reads) rather than re-deriving
// valuation here with placeholder prices, which would weight by share
// count instead of by what each position is actually worth.
const moneySummary = await getMeta("moneySummary", null);
const positions = moneySummary?.positions || [];
if (!positions.length) {
  console.log("no priced positions yet — run `npm run brief:dry` (or wait for the next pull) so there's a real book to weigh sectors against");
  process.exit(1);
}

console.log(`checking ${holdings.length} holdings for a related, rebalance-helping candidate...\n`);

const result = await getStockIdea(config, { holdings, positions }, { force: true });

if (!result || !result.candidates.length) {
  console.log("no candidate found this run — here's exactly where it stopped:\n");
  printDebug(await getMeta("stockIdeaDebug", null));
  process.exit(0);
}

console.log(`as of ${result.at}:\n`);
console.table(result.candidates.map((c) => ({
  ticker: c.symbol, name: c.name, price: c.price, currency: c.currency,
  sector: c.sectorBucket, score: c.aggScore, reason: c.reason,
})));
for (const c of result.candidates) {
  console.log(c.summary ? `\n${c.symbol} — ${c.summary}` : `\n${c.symbol} — (no business summary; see below)`);
}

const debug = await getMeta("stockIdeaDebug", null);
if (debug?.noSummary?.length) {
  console.log("\nwhy a summary is missing, where that happened:");
  for (const e of debug.noSummary) console.log(`  - ${e}`);
}
