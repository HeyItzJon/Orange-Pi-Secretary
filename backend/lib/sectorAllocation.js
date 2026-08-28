// lib/sectorAllocation.js
//
// A look-through GICS-style sector allocation across the whole book — not
// "what sector is each ticker in" (which tells you almost nothing when 90%+
// of the book is two broad ETFs) but "what sector exposure does every
// dollar of the book actually carry," weighting each fund's own underlying
// sector mix by how much of the book that fund is.
//
// Two Yahoo shapes feed this (see lib/sectorProfile.js for the cached fetch
// that gets them):
//   - assetProfile.sector — a single sector string for an individual stock.
//   - topHoldings.sectorWeightings — an array of {sector: fraction} objects
//     for a fund/ETF: an actual look-through of what it holds.
// Both spell the same eleven GICS sectors differently (Yahoo's assetProfile
// says "Consumer Cyclical", the fund payload says "consumer_cyclical", GICS
// itself says "Consumer Discretionary") — GICS_MAP below normalizes all
// three spellings to the eleven official GICS sector names, so a stock and
// a fund that both touch tech land in the same bucket.
//
// Vault fallback: sectorBucket() in lib/stockIdeas.js already reads the
// sector you hand-type into each holding note's frontmatter, for the
// existing stock-idea concentration check. When Yahoo has nothing for a
// ticker — no coverage, or this pull's egress can't reach Yahoo at all —
// that hand-typed label is used instead, as its own single bucket, never
// coerced into a GICS name it isn't actually verified against. See
// buildAllocation() below.

import { sectorBucket } from "./stockIdeas.js";

export const GICS_SECTORS = [
  "Energy", "Materials", "Industrials", "Utilities", "Health Care",
  "Financials", "Consumer Discretionary", "Consumer Staples", "Real Estate",
  "Information Technology", "Communication Services",
];

const GICS_MAP = {
  // Yahoo assetProfile.sector strings (individual stocks)
  "energy": "Energy",
  "basic materials": "Materials",
  "materials": "Materials",
  "industrials": "Industrials",
  "utilities": "Utilities",
  "healthcare": "Health Care",
  "health care": "Health Care",
  "financial services": "Financials",
  "financials": "Financials",
  "consumer cyclical": "Consumer Discretionary",
  "consumer discretionary": "Consumer Discretionary",
  "consumer defensive": "Consumer Staples",
  "consumer staples": "Consumer Staples",
  "real estate": "Real Estate",
  "technology": "Information Technology",
  "information technology": "Information Technology",
  "communication services": "Communication Services",
  // Yahoo topHoldings.sectorWeightings snake_case keys (funds/ETFs)
  "realestate": "Real Estate",
  "consumer_cyclical": "Consumer Discretionary",
  "basic_materials": "Materials",
  "consumer_defensive": "Consumer Staples",
  "communication_services": "Communication Services",
  "financial_services": "Financials",
};

/** Any of Yahoo's spellings -> one canonical GICS name, or null if it isn't
 *  recognized — never guessed at. */
export function toGicsSector(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  return GICS_MAP[key] || GICS_MAP[key.replace(/ /g, "_")] || null;
}

/**
 * Pure: turn one ticker's raw Yahoo quoteSummary modules into a
 * { "GICS name": fraction } map summing to ~1 — a single 1.0 entry for a
 * stock, a real multi-sector split for a fund. Returns null when neither
 * module gave anything usable (an unrecognized sector string, or a fund
 * with no sectorWeightings at all), so the caller knows to fall back
 * rather than silently caching an empty or wrong breakdown.
 */
export function sectorsFromYahoo({ assetProfile, topHoldings } = {}) {
  const weightings = topHoldings?.sectorWeightings;
  if (Array.isArray(weightings) && weightings.length) {
    const out = {};
    let sum = 0;
    for (const row of weightings) {
      for (const [k, v] of Object.entries(row || {})) {
        if (typeof v !== "number") continue;
        const gics = toGicsSector(k);
        if (!gics) continue;
        out[gics] = (out[gics] || 0) + v;
        sum += v;
      }
    }
    if (sum > 0) {
      // Normalize — Yahoo's own fund weightings sometimes sum to a bit
      // under or over 1 (cash and other non-equity positions aren't
      // sector-classified at all, but shouldn't shrink every real sector's
      // share of the pie).
      for (const k of Object.keys(out)) out[k] = out[k] / sum;
      return out;
    }
  }
  const single = toGicsSector(assetProfile?.sector);
  return single ? { [single]: 1 } : null;
}

/**
 * The whole book's look-through sector mix. `positions` is money.js's own
 * priced positions (ticker, weightPct, sector — the vault's hand-typed
 * field); `profiles` is { [ticker]: { sectors: {...}|null } }, one cached
 * Yahoo entry per ticker (lib/sectorProfile.js). A position with no usable
 * Yahoo profile falls back to its own vault sector tag as a single,
 * unmapped bucket — labelled exactly as you wrote it (e.g.
 * "ETF - Canadian Equity"), never coerced into a GICS name it isn't
 * verified against — so a Yahoo outage never means a position just
 * vanishes from the pie. A holding with neither a Yahoo profile nor a
 * vault tag lands in "Unclassified" rather than being silently dropped.
 */
export function buildAllocation(positions = [], profiles = {}) {
  const weights = {};
  for (const p of positions) {
    if (!p.weightPct) continue;
    const sectors = profiles[p.ticker]?.sectors || null;
    if (sectors) {
      for (const [gics, frac] of Object.entries(sectors)) {
        weights[gics] = (weights[gics] || 0) + p.weightPct * frac;
      }
      continue;
    }
    const bucket = sectorBucket(p.sector) || "Unclassified";
    weights[bucket] = (weights[bucket] || 0) + p.weightPct;
  }
  return Object.entries(weights)
    .map(([sector, pct]) => ({ sector, pct: Math.round(pct * 10) / 10 }))
    .filter((s) => s.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}
