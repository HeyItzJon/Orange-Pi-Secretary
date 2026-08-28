// scripts/sync-holdings.js
//
// Force an immediate re-sync of the holdings table from the vault, instead
// of waiting for the next scheduled pull to notice the cached copy is from
// a previous calendar day (config.money.holdingsRefreshDays, default 1 —
// see lib/time.js). Run this right after you edit a `type: holding` note —
// buy something, sell out of a position, update a book value — and want it
// reflected now rather than at the next local midnight.
//
// Run: node scripts/sync-holdings.js

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init } from "../lib/store.js";
import { syncHoldings } from "../sources/money.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

const { holdings, holdingsFrom } = await syncHoldings(config, { force: true });

if (!holdings.length) {
  console.log("no holdings found — check config.money.holdingsFolder and your vault path");
  process.exit(1);
}

console.log(`synced ${holdings.length} holdings from ${holdingsFrom}:\n`);
console.table(holdings.map((h) => ({
  ticker: h.ticker, shares: h.shares, currency: h.currency,
  sector: h.sector, bookValue: h.bookValue, avgCost: h.avgCost,
})));
