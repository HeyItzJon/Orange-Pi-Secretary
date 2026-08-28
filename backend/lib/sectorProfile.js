// lib/sectorProfile.js
//
// Per-ticker sector composition, cached — feeds lib/sectorAllocation.js's
// look-through portfolio pie. Unlike the daily stock-idea-detail cache
// (lib/stockIdeaDetail.js), this isn't tied to a calendar-day boundary: a
// company's GICS sector or a fund's underlying sector mix doesn't
// meaningfully change day to day, so a long, plain age check (default 30
// days) is enough — and it means every 15-minute pull isn't re-hitting
// Yahoo for the same four tickers.
//
// `npm run refresh-sector-profiles` force-refreshes every current holding
// right now, same idea as refresh-stock-idea-detail.js, for when you've
// just added a new position and don't want to wait a pull cycle.

import YahooFinance from "yahoo-finance2";
import { logger } from "./log.js";
import { getMeta, setMeta } from "./store.js";
import { sectorsFromYahoo } from "./sectorAllocation.js";

const log = logger("sectorProfile");
const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const DEFAULT_MAX_AGE_DAYS = 30;

/** Pure: is this cached entry recent enough to skip refetching? A missing
 *  `fetchedAt` (never successfully fetched) is never fresh. */
export function isFresh(entry, now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  if (!entry?.fetchedAt) return false;
  const age = now.getTime() - new Date(entry.fetchedAt).getTime();
  return age < maxAgeDays * 24 * 60 * 60 * 1000;
}

async function fetchOne(ticker) {
  const data = await yahoo.quoteSummary(ticker, { modules: ["assetProfile", "topHoldings"] });
  return { ticker, fetchedAt: new Date().toISOString(), sectors: sectorsFromYahoo(data) };
}

/**
 * One cached entry per ticker, refetched only when missing or stale.
 * `force` re-fetches every ticker regardless of age. Never throws for one
 * bad ticker — a single Yahoo failure is logged and recorded as
 * `sectors: null` with an already-expired `fetchedAt` (the epoch), so
 * lib/sectorAllocation.js falls back to the vault tag for that ticker
 * *and* the next pull tries Yahoo again instead of caching the failure
 * forever.
 */
export async function getSectorProfiles(tickers, { force = false, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const all = (await getMeta("sectorProfiles", {})) || {};
  const now = new Date();
  let changed = false;

  for (const ticker of tickers) {
    if (!force && isFresh(all[ticker], now, maxAgeDays)) continue;
    try {
      all[ticker] = await fetchOne(ticker);
    } catch (err) {
      log.warn(`sector profile unavailable for ${ticker} (${err.message})`);
      all[ticker] = { ticker, fetchedAt: new Date(0).toISOString(), sectors: null };
    }
    changed = true;
  }

  if (changed) await setMeta("sectorProfiles", all);
  return Object.fromEntries(tickers.map((t) => [t, all[t] || null]));
}
