// sources/money.js
//
// Your book, priced live, in one currency.
//
// Three things this fixes over the previous version:
//
//   1. CURRENCY. The old total was Σ price × shares across USD and CAD
//      positions with no conversion — adding US dollars to Canadian ones as
//      if they were the same unit. Every total, every weight and every
//      "biggest position" was wrong. Everything is now converted to one base
//      currency (CAD) at the live rate before anything is summed.
//
//   2. THE HOLDINGS LIST IS NOT A CONFIG FILE. Shares now come from the
//      vault's `type: holding` notes, which are the thing you actually keep
//      up to date. config/portfolio.json survives only as a fallback for when
//      the vault isn't reachable. Buy something new, write the note, and it
//      appears — no code, no config edit.
//
//      The vault itself is only re-read once a calendar day (see
//      syncHoldings, below, and lib/time.js) — every pull in between reads
//      the local `holdings` table instead of walking the vault.
//      `npm run sync-holdings` forces an immediate re-read after you edit
//      a note.
//
//   3. NO HEADLINES. It used to emit "DNA up 7% today" as a brief item. You
//      can read a number. What's left is the position table plus the two
//      things that are genuinely decisions: drift past your band, and
//      contribution day.
//
// Cost: two batched Yahoo calls (quotes + FX) per pull, plus a vault walk
// once a day. No AI, ever.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import YahooFinance from "yahoo-finance2";
import { logger } from "../lib/log.js";
import { itemId, contentHash } from "../lib/ids.js";
import {
  getMeta, setMeta, recordPortfolioDay, recordHoldingDay, portfolioHistory,
  getHoldings, setHoldings,
} from "../lib/store.js";
import { getStockIdea } from "../lib/stockIdeas.js";
import { getSectorProfiles } from "../lib/sectorProfile.js";
import { buildAllocation } from "../lib/sectorAllocation.js";
import { calendarDaysBetween } from "../lib/time.js";
import { resolveVaultPath } from "../lib/paths.js";

const log = logger("money");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.join(__dirname, "..", "config", "portfolio.json");

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ---------------------------------------------------------------- holdings

/** Pull the scalar fields out of a YAML frontmatter block. No YAML parser
 *  needed: holding notes are machine-written and flat. */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, "");
    if (v === "") continue;                       // a list header like "accounts:"
    out[kv[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

/**
 * Every `type: holding` note in the vault. This is the source of truth
 * because it is the thing you maintain by hand; the JSON was a snapshot
 * taken on one particular day and has been quietly rotting since.
 */
async function holdingsFromVault(config) {
  const { path: vaultPath } = resolveVaultPath(config);
  if (!vaultPath) return null;
  const dir = path.join(vaultPath, config.money?.holdingsFolder || "Areas/Finances/Investments");

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn(`vault holdings unreadable at ${dir} (${err.message})`);
    return null;
  }

  const holdings = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    let fm;
    try {
      fm = frontmatter(await fs.readFile(path.join(dir, e.name), "utf-8"));
    } catch { continue; }
    if (!fm || fm.type !== "holding" || !fm.ticker) continue;
    const shares = Number(fm.shares);
    if (!Number.isFinite(shares) || shares <= 0) continue;   // sold out, or a stub
    holdings.push({
      ticker: String(fm.ticker).trim(),
      shares,
      // The note declares its own currency, so we never have to infer it from
      // the ticker suffix — which would get NE/CN listings wrong.
      currency: fm.currency ? String(fm.currency).toUpperCase() : null,
      sector: fm.sector || null,
      bookValue: Number.isFinite(Number(fm.book_value)) ? Number(fm.book_value) : null,
      avgCost: Number.isFinite(Number(fm.avg_cost)) ? Number(fm.avg_cost) : null,
    });
  }
  return holdings.length ? holdings : null;
}

async function holdingsFromJson() {
  const raw = await fs.readFile(PORTFOLIO_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  return (parsed.holdings || []).map((h) => ({
    ticker: h.ticker, shares: Number(h.shares) || 0,
    currency: h.currency ? String(h.currency).toUpperCase() : null,
    sector: h.sector || null, bookValue: null, avgCost: null,
  }));
}

/**
 * The holdings list, refreshed from the vault once a calendar day instead
 * of on every 15-minute pull. The local `holdings` table (synced on the
 * last successful read) is the source every pull actually reads from; the
 * vault itself only gets touched the first time this is checked after
 * local midnight (config.timezone) — `config.money.holdingsRefreshDays`
 * (default 1) tunes how many days apart, same idea and same lib/time.js
 * math the stock idea's daily refresh uses. Buy or sell something and want
 * it to show up now rather than waiting? Run `npm run sync-holdings` for
 * an immediate forced refresh.
 */
export async function syncHoldings(config, { force = false } = {}) {
  const tz = config.timezone || "America/Toronto";
  const refreshDays = Math.max(1, config.money?.holdingsRefreshDays ?? 1);
  const syncedAt = await getMeta("holdingsSyncedAt", null);
  const stale = force || !syncedAt || calendarDaysBetween(syncedAt, new Date().toISOString(), tz) >= refreshDays;

  if (!stale) {
    const cached = await getHoldings();
    if (cached.length) return { holdings: cached, holdingsFrom: "cache" };
    // Table's unexpectedly empty despite a fresh sync stamp — fall through
    // and sync for real rather than returning nothing.
  }

  const fresh = await holdingsFromVault(config);
  if (fresh) {
    await setHoldings(fresh, "vault");
    await setMeta("holdingsSyncedAt", new Date().toISOString());
    log.info(`holdings synced from vault (${fresh.length} positions)`);
    return { holdings: fresh, holdingsFrom: "vault" };
  }

  // Vault unreachable this cycle (offline, path moved, transient error) —
  // use the last good copy rather than failing the whole pull over it.
  const cached = await getHoldings();
  if (cached.length) return { holdings: cached, holdingsFrom: "cache (vault unreachable)" };

  try {
    const fromJson = await holdingsFromJson();
    await setHoldings(fromJson, "config/portfolio.json");
    await setMeta("holdingsSyncedAt", new Date().toISOString());
    return { holdings: fromJson, holdingsFrom: "config/portfolio.json" };
  } catch (err) {
    log.warn(`no holdings anywhere (${err.message}) — skipping money`);
    return { holdings: [], holdingsFrom: "none" };
  }
}

// ------------------------------------------------------------------ quotes

/** One request for the whole book, chunked only because URLs have limits. */
async function quoteAll(tickers) {
  const out = new Map();
  const size = 40;
  for (let i = 0; i < tickers.length; i += size) {
    const chunk = tickers.slice(i, i + size);
    try {
      const res = await yahoo.quote(chunk);
      for (const q of Array.isArray(res) ? res : [res]) if (q?.symbol) out.set(q.symbol, q);
    } catch (err) {
      log.warn(`batch quote failed (${err.message}) — falling back to singles`);
      for (const t of chunk) {
        try {
          const q = await yahoo.quote(t);
          if (q?.symbol) out.set(q.symbol, q);
        } catch { log.warn(`no quote for ${t}`); }
      }
    }
  }
  return out;
}

/**
 * Live FX for every currency in the book. Without this the total is a
 * meaningless mixed-unit sum — the bug this rewrite exists to kill.
 */
async function fxRates(currencies, base) {
  const rates = { [base]: 1 };
  const need = [...new Set(currencies)].filter((c) => c && c !== base);
  if (!need.length) return rates;

  const pairs = need.map((c) => `${c}${base}=X`);
  try {
    const res = await yahoo.quote(pairs);
    for (const q of Array.isArray(res) ? res : [res]) {
      const from = String(q?.symbol || "").slice(0, 3);
      if (q?.regularMarketPrice > 0) rates[from] = q.regularMarketPrice;
    }
  } catch (err) {
    log.warn(`FX lookup failed: ${err.message}`);
  }
  for (const c of need) if (!rates[c]) log.error(`no FX rate for ${c} — those positions are excluded`);
  return rates;
}

// -------------------------------------------------------------- valuation

/**
 * Turn priced rows into one book, in one currency.
 *
 * This is the function the whole rewrite exists for, so it is pure and it is
 * tested. What it replaced summed `price * shares` straight across USD and
 * CAD holdings — a $485 US stock counted as $485 Canadian. That understated
 * every US position by the exchange rate and corrupted the total, every
 * weight, and therefore which position looked biggest.
 *
 * `dayPct` values yesterday's close at TODAY's rate deliberately: it measures
 * what the securities did, not what the currency did. Otherwise an overnight
 * FX swing reads as your portfolio moving while nothing actually traded.
 */
export function valueBook(rows, fx, base) {
  const rate = (cur) => fx[cur] ?? null;
  const priced = rows.filter((r) => r.price != null && rate(r.currency));

  const total = priced.reduce((s, r) => s + r.price * r.shares * rate(r.currency), 0);
  const prevTotal = priced.reduce((s, r) => {
    const prev = r.prevClose ?? r.price / (1 + (r.dayChangePct || 0) / 100);
    return s + prev * r.shares * rate(r.currency);
  }, 0);
  const dayPct = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0;

  const positions = rows
    .map((r) => {
      const fxRate = rate(r.currency);
      const value = r.price != null && fxRate ? r.price * r.shares * fxRate : null;
      // book_value in a vault holding note is recorded in that holding's own
      // currency, so it needs the same conversion the market value gets.
      const book = r.bookValue != null && fxRate ? r.bookValue * fxRate : null;
      return {
        ticker: r.ticker,
        name: r.name || null,
        sector: r.sector || null,
        shares: r.shares,
        price: r.price,
        currency: r.currency,
        fxRate,
        value,                                   // always in `base`
        dayChangePct: r.dayChangePct,
        // What the move was worth. 0.4% on your largest holding moves more
        // money than 6% on the smallest; a percentage alone hides that.
        dayChangeValue: value != null && r.dayChangePct != null
          ? value - value / (1 + r.dayChangePct / 100) : null,
        weightPct: total > 0 && value ? (value / total) * 100 : 0,
        bookValue: book,
        totalReturnPct: book && value ? ((value - book) / book) * 100 : null,
        stale: Boolean(r.stale),
        unavailable: Boolean(r.unavailable),
        quotedAt: r.quotedAt || null,
        marketState: r.marketState || null,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  return { total, prevTotal, dayPct, positions };
}

/**
 * Weight (%) per settlement currency, from priced positions — a CAD/USD
 * split at a glance. Pure, and much cheaper than the sector look-through:
 * every holding already declares its own currency (the vault note, or
 * Yahoo's own quote), so this needs no extra fetch at all.
 */
export function currencyExposure(positions) {
  const weights = {};
  for (const p of positions || []) {
    if (!p.weightPct || !p.currency) continue;
    weights[p.currency] = (weights[p.currency] || 0) + p.weightPct;
  }
  return Object.entries(weights)
    .map(([currency, pct]) => ({ currency, pct: Math.round(pct * 10) / 10 }))
    .sort((a, b) => b.pct - a.pct);
}

/**
 * One human-readable market-status line for the book as a whole, instead
 * of whichever row's raw `marketState` the old code happened to grab
 * first — which is how "market postpost" (Yahoo's real enum value for
 * the second post-market phase, lowercased and shown as-is) ended up on
 * screen. The book spans two markets — US-listed and Canadian/TSX-listed
 * — and they don't always share a session: a US holiday with no matching
 * TSX holiday, mismatched pre/post-market windows, and so on. This looks
 * at every position's own state and names which market(s) are actually
 * open, standardized to five outcomes: "pre-market", "markets open" (both),
 * "US markets open" / "TSX open" (only one), "post-market". Anything else
 * (both closed, no data) returns null — nothing worth saying.
 *
 * Currency is the market signal (USD -> US-listed, CAD -> TSX-listed)
 * rather than a real exchange lookup — an approximation, not a rigorous
 * listing check, but a reliable one for a Canadian investor's book: a
 * CAD-settled position is TSX business, a USD one is a US exchange. Same
 * kind of simplifying assumption as stockIdeas.js's sector bucketing.
 */
export function marketStatusLabel(rows) {
  const isOpen = (s) => s === "REGULAR";
  const isPre = (s) => s === "PRE" || s === "PREPRE";
  const isPost = (s) => s === "POST" || s === "POSTPOST";

  const withState = (rows || []).filter((r) => r.marketState);
  const us = withState.filter((r) => r.currency === "USD").map((r) => r.marketState);
  const ca = withState.filter((r) => r.currency === "CAD").map((r) => r.marketState);
  const other = withState
    .filter((r) => r.currency !== "USD" && r.currency !== "CAD")
    .map((r) => r.marketState);

  const usOpen = us.some(isOpen);
  const caOpen = ca.some(isOpen);

  // Open beats pre/post: if anything is actually trading, that is the
  // fact worth leading with.
  if (usOpen && caOpen) return "markets open";
  if (usOpen) return "US markets open";
  if (caOpen) return "TSX open";
  if (other.some(isOpen)) return "markets open";

  const all = [...us, ...ca, ...other];
  if (all.some(isPre)) return "pre-market";
  if (all.some(isPost)) return "post-market";
  return null;
}

// ------------------------------------------------------------------- main

export async function collectMoney(config) {
  const cfg = config.money || {};
  const base = (cfg.baseCurrency || "CAD").toUpperCase();

  const { holdings, holdingsFrom } = await syncHoldings(config);
  if (!holdings.length) return [];
  log.info(`${holdings.length} holdings from ${holdingsFrom}`);

  const quotes = await quoteAll(holdings.map((h) => h.ticker));
  const priceCache = (await getMeta("priceCache", {})) || {};
  const now = new Date();

  // --------------------------------------------------------------- price
  const rows = holdings.map((h) => {
    const q = quotes.get(h.ticker);
    if (q?.regularMarketPrice != null) {
      const live = {
        price: q.regularMarketPrice,
        currency: (q.currency || h.currency || base).toUpperCase(),
        dayChangePct: q.regularMarketChangePercent ?? 0,
        prevClose: q.regularMarketPreviousClose ?? null,
        name: q.shortName || q.longName || null,
        marketState: q.marketState || null,
        quotedAt: (q.regularMarketTime ? new Date(q.regularMarketTime) : now).toISOString(),
      };
      priceCache[h.ticker] = live;
      return { ...h, ...live, stale: false };
    }
    // Yahoo dropped this one. Say so — an old price shown as current is
    // exactly the kind of quiet lie this rewrite is meant to stop.
    const cached = priceCache[h.ticker];
    return cached
      ? { ...h, ...cached, currency: (cached.currency || h.currency || base).toUpperCase(), stale: true }
      : { ...h, price: null, dayChangePct: null, currency: h.currency || base, stale: true, unavailable: true };
  });

  await setMeta("priceCache", priceCache);

  // ------------------------------------------------------------------ FX
  const fx = await fxRates(rows.map((r) => r.currency), base);
  const { total, dayPct, prevTotal, positions } = valueBook(rows, fx, base);

  // A rolling daily total so the screen can say "week +2.1%". One row per
  // day — and, alongside the total, `dayPct`: the weighted move in what the
  // holdings themselves did (from valueBook, above), not the total-to-total
  // diff. The total moves on a contribution or a withdrawal too, and the
  // year page's colour grid reads this field directly, so recording the
  // wrong one would paint a deposit day as a market swing it never was.
  //
  // `dayValue` is the same measurement in dollars rather than percent
  // (total - prevTotal, the same figure moneySummary.dayChangeValue below
  // already computes) — a percentage alone hides that 0.4% on the whole
  // book can be more money than 6% on one small holding. Stored per day,
  // in `base`, so the year page can show it on hover and so it's sitting
  // here ready for whatever gets built on top of the history next.
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone || "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const dayValue = total - prevTotal;
  await recordPortfolioDay(stamp, { total, dayPct, dayValue, base });

  // Per-holding daily history — new. Skip anything with no price today
  // rather than record a fabricated data point for an unavailable ticker.
  for (const p of positions) {
    if (p.price == null) continue;
    await recordHoldingDay(stamp, p.ticker, {
      price: p.price,
      dayChangePct: p.dayChangePct ?? null,
      dayChangeValue: p.dayChangeValue ?? null,
      shares: p.shares ?? null,
      value: p.value ?? null,
      currency: p.currency ?? null,
    });
  }

  const history = await portfolioHistory();

  const changeOver = (days) => {
    const cutoff = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone || "America/Toronto",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(now.getTime() - days * 86400000));
    const past = history.filter((h) => h.date <= cutoff).pop();
    return past?.total ? ((total - past.total) / past.total) * 100 : null;
  };

  // The raw enum straight off whichever row happened to be first — kept
  // only for the sources-panel diagnostic API (/api/sources), never shown
  // to a person. Yahoo's actual values ("PRE", "POSTPOST", ...) read as a
  // bug when surfaced directly — see marketStatusLabel below for what the
  // money page itself shows.
  const marketState = rows.find((r) => r.marketState)?.marketState || null;
  const marketStatus = marketStatusLabel(rows);

  // A related, possibly rebalance-helping ticker — see lib/stockIdeas.js.
  // Refreshed once a calendar day (lib/time.js), so most pulls just read
  // the cache; a failure here should never take down the rest of the
  // money page.
  let stockIdea = null;
  try {
    stockIdea = await getStockIdea(config, { holdings, positions });
  } catch (err) {
    log.warn(`stock idea unavailable this pull (${err.message})`);
  }

  // Look-through GICS sector mix — see lib/sectorProfile.js (the cached
  // Yahoo fetch, ~30-day age check, not tied to this pull's cadence) and
  // lib/sectorAllocation.js (the pure weighting math). A failure here
  // should never take down the rest of the money page either.
  let sectorAllocation = [];
  try {
    const profiles = await getSectorProfiles(positions.map((p) => p.ticker));
    sectorAllocation = buildAllocation(positions, profiles);
  } catch (err) {
    log.warn(`sector allocation unavailable this pull (${err.message})`);
  }

  await setMeta("moneySummary", {
    at: now.toISOString(),
    base,
    total,
    dayPct,
    dayChangeValue: total - prevTotal,
    weekPct: changeOver(7),
    monthPct: changeOver(30),
    holdingCount: rows.length,
    holdingsFrom,
    marketState,                                  // raw Yahoo enum — diagnostic only, see above
    marketStatus,                                 // the standardized label the money page shows
    sectorAllocation,
    currencyExposure: currencyExposure(positions),
    fx: Object.fromEntries(Object.entries(fx).filter(([c]) => c !== base)),
    unavailable: rows.filter((r) => r.unavailable).map((r) => r.ticker),
    stale: rows.filter((r) => r.stale && !r.unavailable).map((r) => r.ticker),
    historyDays: history.length,
    positions,
    stockIdea: stockIdea?.candidates || [],
    stockIdeaAt: stockIdea?.at || null,
  });

  // ------------------------------- rules -------------------------------
  // Only things that are a DECISION. Price moves are not; they're on the
  // positions table where they belong.
  const items = [];
  const driftBand = cfg.driftBandPct ?? 5;

  for (const p of positions) {
    const target = (cfg.targets || {})[p.ticker];
    if (target == null || p.value == null) continue;
    const drift = p.weightPct - target;
    if (Math.abs(drift) < driftBand) continue;
    items.push({
      id: itemId("money", `drift:${p.ticker}`),
      source: "money",
      kind: "drift",
      title: `${p.ticker} is ${p.weightPct.toFixed(1)}% of the book vs ${target}% target`,
      detail: `${drift > 0 ? "Over" : "Under"} your band by ${Math.abs(drift).toFixed(1)} points`,
      url: null,
      dueAt: null,
      category: "money",
      domain: "finance",
      categoryLabel: "Drift",
      categoryWeight: 24,
      unmissable: false,
      emphasised: false,
      tier: "money",
      reasons: [`drifted past your ${driftBand} point band`],
      contentHash: contentHash({ t: p.ticker, w: Math.round(p.weightPct) }),
      meta: { ticker: p.ticker, weightPct: p.weightPct, targetPct: target },
    });
  }

  const contribDay = cfg.contributionDayOfMonth;
  if (contribDay) {
    const dom = Number(new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone || "America/Toronto", day: "numeric",
    }).format(now));
    const lead = cfg.contributionLeadDays ?? 1;
    if (dom >= contribDay - lead && dom <= contribDay) {
      const monthKey = now.toISOString().slice(0, 7);
      items.push({
        id: itemId("money", `contribution:${monthKey}`),
        source: "money",
        kind: "contribution",
        title: cfg.contributionLabel || "Contribution day",
        detail: cfg.contributionNote || `Scheduled for the ${contribDay}th`,
        url: null, dueAt: null,
        category: "money", domain: "finance",
        categoryLabel: "Contribution", categoryWeight: 34,
        unmissable: false, emphasised: false, tier: "money",
        reasons: ["scheduled contribution"],
        contentHash: contentHash({ m: monthKey }),
        meta: { monthKey },
      });
    }
  }

  const bad = rows.filter((r) => r.stale || r.unavailable).length;
  log.info(
    `${rows.length} holdings · ${base} ${Math.round(total).toLocaleString()} · ` +
    `day ${dayPct.toFixed(2)}% · fx ${JSON.stringify(fx)}${bad ? ` · ${bad} not live` : ""}`
  );
  return items;
}
