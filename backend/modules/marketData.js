// marketData.js
//
// Reads your REAL holdings from config/portfolio.json and fetches live
// prices via Yahoo Finance (no API key needed, covers most exchanges
// including TSX with the .TO suffix).
//
// THE CRASH FIX: every ticker is fetched inside its own try/catch. If one
// fails (delisted, typo, API hiccup), it's skipped and logged - it never
// takes down the others or the whole pipeline. On top of that, every
// successful fetch is cached to disk, so if Yahoo is down entirely, the
// dashboard still shows the last known prices instead of breaking.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.join(__dirname, "..", "config", "portfolio.json");
const CACHE_PATH = path.join(__dirname, "..", "data", "price-cache.json");

// v3 requires instantiation
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

async function loadPortfolioConfig() {
  const raw = await fs.readFile(PORTFOLIO_PATH, "utf-8");
  return JSON.parse(raw);
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Add delay between requests to avoid rate limiting
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOneTicker(ticker, cache) {
  try {
    const result = await yahooFinance.quote(ticker);
    const priceData = {
      ticker,
      price: result.regularMarketPrice,
      currency: result.currency,
      dayChangePct: result.regularMarketChangePercent,
      stale: false,
      fetchedAt: new Date().toISOString()
    };
    cache[ticker] = priceData;
    return priceData;
  } catch (err) {
    const errMsg = err.message || String(err);
    console.error(`[marketData] Failed to fetch "${ticker}": ${errMsg}`);
    
    if (cache[ticker]) {
      // Fall back to last known price rather than dropping the holding entirely.
      return { ...cache[ticker], stale: true };
    }
    // Never fetched successfully before - skip it, don't crash the pipeline.
    return null;
  }
}

export async function getPortfolioSummary() {
  const { holdings, lastRebalanced } = await loadPortfolioConfig();
  const cache = await loadCache();

  const fetched = [];
  
  console.log(`[marketData] Fetching prices for ${holdings.length} holdings (with delays to avoid rate limits)...`);
  
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    
    // Add a 500ms delay between requests to avoid Yahoo rate limiting
    if (i > 0) {
      await delay(500);
    }
    
    const priceData = await fetchOneTicker(h.ticker, cache);
    if (priceData) {
      fetched.push({ ...h, ...priceData, value: (priceData.price || 0) * h.shares });
    } else {
      fetched.push({ ...h, price: null, dayChangePct: null, value: 0, stale: true, unavailable: true });
    }
    
    // Log progress every 10 tickers
    if ((i + 1) % 10 === 0) {
      console.log(`[marketData] ${i + 1}/${holdings.length} complete`);
    }
  }

  await saveCache(cache);

  const totalValue = fetched.reduce((sum, h) => sum + (h.value || 0), 0);
  const holdingsWithWeight = fetched.map(h => ({
    ...h,
    weightPct: totalValue > 0 ? Math.round((h.value / totalValue) * 1000) / 10 : 0
  }));

  const successCount = holdingsWithWeight.filter(h => !h.unavailable).length;
  console.log(`[marketData] ${successCount}/${holdings.length} tickers fetched successfully`);

  return { holdings: holdingsWithWeight, lastRebalanced };
}

export async function getNewsSummary() {
  // Still a simple placeholder - real news wiring is a separate step,
  // kept out of this pass to avoid mixing two API integrations at once.
  return [
    "Fed signals rate decision next week",
    "Tech sector volatility up on earnings season",
    "Energy stocks lagging broader market this month"
  ];
}
