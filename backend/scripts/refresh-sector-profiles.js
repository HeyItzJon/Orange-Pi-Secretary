// scripts/refresh-sector-profiles.js
//
// Force an immediate re-fetch of every current holding's sector profile
// (lib/sectorProfile.js) — the per-ticker Yahoo data behind the Year page's
// look-through GICS sector pie — bypassing the normal ~30-day cache. Run
// this right after adding a new holding, or any time you want to check the
// live breakdown without waiting for the cache to go stale.
//
// Prints each ticker's resolved sector mix, then the whole book's combined
// allocation (same math the Year page shows).
//
// Run: node scripts/refresh-sector-profiles.js

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, getMeta } from "../lib/store.js";
import { getSectorProfiles } from "../lib/sectorProfile.js";
import { buildAllocation } from "../lib/sectorAllocation.js";
import { syncHoldings } from "../sources/money.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

const { holdings, holdingsFrom } = await syncHoldings(config);
if (!holdings.length) {
  console.log("no holdings found — check config.money.holdingsFolder and your vault path");
  process.exit(1);
}
console.log(`pulling live sector profiles for ${holdings.length} holdings (from ${holdingsFrom})...\n`);

const tickers = holdings.map((h) => h.ticker);
const profiles = await getSectorProfiles(tickers, { force: true });

for (const ticker of tickers) {
  const p = profiles[ticker];
  if (!p?.sectors) {
    console.log(`${ticker}: no Yahoo sector data — will fall back to the vault's own sector tag`);
    continue;
  }
  const parts = Object.entries(p.sectors)
    .sort((a, b) => b[1] - a[1])
    .map(([sector, frac]) => `${sector} ${(frac * 100).toFixed(0)}%`);
  console.log(`${ticker}: ${parts.join(", ")}`);
}

// The positions table's own weightPct is what this gets weighted by on a
// real pull — this script doesn't re-price anything, so it approximates
// with an equal-weight-by-share-count stand-in just to show the combine
// step; the real numbers come from the next scheduled pull once this
// cache is warm.
const money = await getMeta("moneySummary", null);
if (money?.positions?.length) {
  console.log(`\n--- combined book allocation (using the last priced pull's weights) ---`);
  const alloc = buildAllocation(money.positions, profiles);
  for (const s of alloc) console.log(`${s.sector.padEnd(24)} ${s.pct.toFixed(1)}%`);
} else {
  console.log(`\n(no priced positions on record yet — run \`npm run brief\` once to see the combined allocation)`);
}
