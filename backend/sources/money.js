// sources/money.js
//
// Money speaks only when a rule fires. Most days that is nothing, and the
// section disappears from the brief entirely.
//
// This is a deliberate reversal of v1, which generated a daily AI stock pitch
// grounded in hardcoded macro data. There is no AI here at all, and no
// invented context — only your actual positions and thresholds you set.
//
// Cost: ONE batched Yahoo call per day for every ticker, instead of v1's 40
// sequential calls with 500ms sleeps (20+ seconds of wall clock).
//
// Nothing here is advice. It reports what moved and what drifted; every
// decision stays yours.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import YahooFinance from "yahoo-finance2";
import { logger } from "../lib/log.js";
import { itemId, contentHash, } from "../lib/ids.js";
import { getMeta, setMeta } from "../lib/store.js";

const log = logger("money");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.join(__dirname, "..", "config", "portfolio.json");

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

async function loadPortfolio() {
  const raw = await fs.readFile(PORTFOLIO_PATH, "utf-8");
  return JSON.parse(raw);
}

/** One request for the whole book, chunked only because URLs have limits. */
async function quoteAll(tickers) {
  const out = new Map();
  const size = 40;
  for (let i = 0; i < tickers.length; i += size) {
    const chunk = tickers.slice(i, i + size);
    try {
      const res = await yahoo.quote(chunk);
      for (const q of Array.isArray(res) ? res : [res]) {
        if (q?.symbol) out.set(q.symbol, q);
      }
    } catch (err) {
      log.warn(`batch quote failed (${err.message}) — falling back to singles`);
      for (const t of chunk) {
        try {
          const q = await yahoo.quote(t);
          if (q?.symbol) out.set(q.symbol, q);
        } catch {
          log.warn(`no quote for ${t}`);
        }
      }
    }
  }
  return out;
}

export async function collectMoney(config) {
  const cfg = config.money || {};
  let portfolio;
  try {
    portfolio = await loadPortfolio();
  } catch (err) {
    log.warn(`no portfolio config (${err.message}) — skipping money`);
    return [];
  }

  const holdings = portfolio.holdings || [];
  if (!holdings.length) return [];

  const priceCache = (await getMeta("priceCache", {})) || {};
  const quotes = await quoteAll(holdings.map((h) => h.ticker));

  const rows = holdings.map((h) => {
    const q = quotes.get(h.ticker);
    if (q?.regularMarketPrice != null) {
      priceCache[h.ticker] = {
        price: q.regularMarketPrice,
        currency: q.currency,
        dayChangePct: q.regularMarketChangePercent ?? 0,
        at: new Date().toISOString(),
      };
      return { ...h, ...priceCache[h.ticker], stale: false };
    }
    const cached = priceCache[h.ticker];
    return cached
      ? { ...h, ...cached, stale: true }
      : { ...h, price: null, dayChangePct: null, stale: true, unavailable: true };
  });

  await setMeta("priceCache", priceCache);

  const priced = rows.filter((r) => r.price != null);
  const total = priced.reduce((s, r) => s + r.price * (r.shares || 0), 0);
  const prevTotal = priced.reduce(
    (s, r) => s + (r.price / (1 + (r.dayChangePct || 0) / 100)) * (r.shares || 0),
    0
  );
  const dayPct = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0;

  const withWeight = rows.map((r) => ({
    ...r,
    value: r.price != null ? r.price * (r.shares || 0) : 0,
    weightPct: total > 0 && r.price != null ? (r.price * (r.shares || 0) / total) * 100 : 0,
  }));

  await setMeta("moneySummary", {
    at: new Date().toISOString(),
    total,
    dayPct,
    holdingCount: rows.length,
    unavailable: rows.filter((r) => r.unavailable).length,
    stale: rows.filter((r) => r.stale && !r.unavailable).length,
    holdings: withWeight
      .slice()
      .sort((a, b) => b.value - a.value)
      .map((r) => ({
        ticker: r.ticker, price: r.price, dayChangePct: r.dayChangePct,
        weightPct: Number(r.weightPct.toFixed(1)), value: r.value, stale: r.stale,
      })),
  });

  // ------------------------------- rules -------------------------------
  const items = [];
  const moveThreshold = cfg.dayMovePct ?? 5;
  const driftBand = cfg.driftBandPct ?? 5;
  const today = new Date();

  for (const r of withWeight) {
    if (r.dayChangePct == null || r.stale) continue;
    if (Math.abs(r.dayChangePct) < moveThreshold) continue;
    const dir = r.dayChangePct > 0 ? "up" : "down";
    items.push({
      id: itemId("money", `move:${r.ticker}:${today.toISOString().slice(0, 10)}`),
      source: "money",
      kind: "move",
      title: `${r.ticker} ${dir} ${Math.abs(r.dayChangePct).toFixed(1)}% today`,
      detail: `${r.weightPct.toFixed(1)}% of the book · $${r.price?.toFixed(2)} ${r.currency || ""}`.trim(),
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(r.ticker)}`,
      dueAt: null,
      category: "money",
      categoryLabel: "Move",
      categoryWeight: 26,
      unmissable: false,
      emphasised: false,
      tier: "money",
      reasons: [`moved more than ${moveThreshold}%`],
      contentHash: contentHash({ t: r.ticker, d: r.dayChangePct.toFixed(1) }),
      meta: { ticker: r.ticker, dayChangePct: r.dayChangePct },
    });
  }

  for (const r of withWeight) {
    if (r.targetPct == null || r.price == null) continue;
    const drift = r.weightPct - r.targetPct;
    if (Math.abs(drift) < driftBand) continue;
    items.push({
      id: itemId("money", `drift:${r.ticker}`),
      source: "money",
      kind: "drift",
      title: `${r.ticker} is ${r.weightPct.toFixed(1)}% vs ${r.targetPct}% target`,
      detail: `${drift > 0 ? "Over" : "Under"} your band by ${Math.abs(drift).toFixed(1)} points`,
      url: null,
      dueAt: null,
      category: "money",
      categoryLabel: "Drift",
      categoryWeight: 24,
      unmissable: false,
      emphasised: false,
      tier: "money",
      reasons: [`drifted past ${driftBand} point band`],
      contentHash: contentHash({ t: r.ticker, w: Math.round(r.weightPct) }),
      meta: { ticker: r.ticker, weightPct: r.weightPct, targetPct: r.targetPct },
    });
  }

  // Contribution reminder: fires on the configured day of month, in a window.
  const contribDay = cfg.contributionDayOfMonth;
  if (contribDay) {
    const dom = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone || "America/Toronto", day: "numeric" })
        .format(today)
    );
    const lead = cfg.contributionLeadDays ?? 1;
    if (dom >= contribDay - lead && dom <= contribDay) {
      const monthKey = today.toISOString().slice(0, 7);
      items.push({
        id: itemId("money", `contribution:${monthKey}`),
        source: "money",
        kind: "contribution",
        title: cfg.contributionLabel || "Contribution day",
        detail: cfg.contributionNote || `Scheduled for the ${contribDay}${contribDay === 1 ? "st" : "th"}`,
        url: null,
        dueAt: null,
        category: "money",
        categoryLabel: "Contribution",
        categoryWeight: 34,
        unmissable: false,
        emphasised: false,
        tier: "money",
        reasons: ["scheduled contribution"],
        contentHash: contentHash({ m: monthKey }),
        meta: { monthKey },
      });
    }
  }

  log.info(`${rows.length} holdings, ${items.length} rule hit(s), total $${Math.round(total).toLocaleString()}`);
  return items;
}
