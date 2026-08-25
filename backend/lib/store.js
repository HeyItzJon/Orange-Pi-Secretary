// store.js
//
// The memory. Everything the secretary knows persists here.
//
// Backed by SQLite (node:sqlite, see ./db.js) — every write below is a
// single synchronous statement against the database file, so there's no
// in-memory snapshot two overlapping calls could clobber. That was the
// whole reason the old JSON-file version needed a hand-rolled mutex; it's
// gone here because the failure mode it guarded against can't happen.
// Durability on power loss comes from SQLite's own WAL journal instead of
// the old temp-file+rename dance.
//
// Every exported function here keeps the exact signature and return shape
// it had when this was a JSON blob — nothing else in the codebase knows
// (or needs to know) how storage works.

import { getDb } from "./db.js";
import { logger } from "./log.js";

const log = logger("store");

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- items

function readItem(dbc, id) {
  const row = dbc.prepare("SELECT data FROM items WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

function writeItem(dbc, id, item) {
  dbc.prepare(`
    INSERT INTO items (id, status, source, dueAt, firstSeen, lastSeen, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      dueAt = excluded.dueAt,
      firstSeen = excluded.firstSeen,
      lastSeen = excluded.lastSeen,
      data = excluded.data
  `).run(
    id,
    item.status ?? "open",
    item.source ?? null,
    item.dueAt ?? null,
    item.firstSeen ?? null,
    item.lastSeen ?? null,
    JSON.stringify(item)
  );
}

export async function init() {
  const dbc = getDb();
  const { c } = dbc.prepare("SELECT COUNT(*) AS c FROM items").get();
  log.info(`loaded ${c} items`);
  return dbc;
}

/**
 * Insert or update an item, preserving everything the system has learned
 * about it — first_seen, how many times you've been told, whether you
 * dismissed it. This is the heart of "don't repeat yourself".
 */
export async function upsertItem(incoming) {
  const dbc = getDb();
  const now = nowIso();
  const prev = readItem(dbc, incoming.id);

  let item;
  if (!prev) {
    item = {
      status: "open",
      surfaceCount: 0,
      lastSurfaced: null,
      snoozeUntil: null,
      ...incoming,
      firstSeen: now,
      lastSeen: now,
      changed: false,
    };
  } else {
    const contentChanged = prev.contentHash !== incoming.contentHash;
    item = {
      ...prev,
      ...incoming,
      firstSeen: prev.firstSeen,
      lastSeen: now,
      status: prev.status,
      surfaceCount: prev.surfaceCount,
      lastSurfaced: prev.lastSurfaced,
      snoozeUntil: prev.snoozeUntil,
      // A changed item earns the right to be shown again.
      changed: contentChanged || prev.changed,
    };
  }
  writeItem(dbc, incoming.id, item);
  return item;
}

export async function upsertMany(items) {
  const out = [];
  for (const it of items) out.push(await upsertItem(it));
  return out;
}

export async function allItems() {
  const dbc = getDb();
  return dbc.prepare("SELECT data FROM items").all().map((r) => JSON.parse(r.data));
}

export async function getItem(id) {
  return readItem(getDb(), id);
}

export async function patchItem(id, fields) {
  const dbc = getDb();
  const prev = readItem(dbc, id);
  if (!prev) return null;
  const item = { ...prev, ...fields };
  writeItem(dbc, id, item);
  return item;
}

/** Record that these items went out in a brief — drives suppression. */
export async function markSurfaced(ids) {
  const dbc = getDb();
  const now = nowIso();
  for (const id of ids) {
    const it = readItem(dbc, id);
    if (!it) continue;
    it.surfaceCount = (it.surfaceCount || 0) + 1;
    it.lastSurfaced = now;
    it.changed = false; // the change has now been reported
    writeItem(dbc, id, it);
  }
}

/** Drop resolved/expired items so the store doesn't grow without bound. */
export async function prune({ maxAgeDays = 90 } = {}) {
  const dbc = getDb();
  const cutoffIso = new Date(Date.now() - maxAgeDays * 86400000).toISOString();

  const result = dbc.prepare(`
    DELETE FROM items
    WHERE COALESCE(lastSeen, firstSeen) < ?
      AND (status IN ('done', 'dismissed') OR dueAt IS NULL)
  `).run(cutoffIso);
  const removed = result.changes;

  const { c: seenCount } = dbc.prepare("SELECT COUNT(*) AS c FROM seen_message_ids").get();
  if (seenCount > 3000) {
    dbc.exec(`
      DELETE FROM seen_message_ids
      WHERE message_id NOT IN (
        SELECT message_id FROM seen_message_ids ORDER BY seen_at DESC LIMIT 2000
      )
    `);
  }

  const cacheCutoffIso = new Date(Date.now() - 30 * 86400000).toISOString();
  dbc.prepare("DELETE FROM ai_cache WHERE at < ?").run(cacheCutoffIso);

  if (removed) log.info(`pruned ${removed} items`);
  return removed;
}

// ------------------------------------------------- gmail message id dedup

export async function knownMessageIds() {
  const dbc = getDb();
  const rows = dbc.prepare("SELECT message_id FROM seen_message_ids").all();
  return new Set(rows.map((r) => r.message_id));
}

export async function rememberMessageIds(ids) {
  const dbc = getDb();
  const now = nowIso();
  const stmt = dbc.prepare(`
    INSERT INTO seen_message_ids (message_id, seen_at) VALUES (?, ?)
    ON CONFLICT(message_id) DO UPDATE SET seen_at = excluded.seen_at
  `);
  for (const id of ids) stmt.run(id, now);
}

// ------------------------------------------------------------- ai cache

export async function cacheGet(key) {
  const row = getDb().prepare("SELECT value FROM ai_cache WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

export async function cacheSet(key, value) {
  const dbc = getDb();
  dbc.prepare(`
    INSERT INTO ai_cache (key, value, at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at
  `).run(key, JSON.stringify(value), nowIso());
}

// ----------------------------------------------------------------- meta

export async function getMeta(key, fallback = null) {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export async function setMeta(key, value) {
  const dbc = getDb();
  dbc.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

/** Running tally of what the AI has cost us. Visible at /api/usage. */
export async function addUsage({ calls = 0, promptTokens = 0, completionTokens = 0 }) {
  const day = nowIso().slice(0, 10);
  const u = (await getMeta("usage", {})) || {};
  const d = u[day] || { calls: 0, promptTokens: 0, completionTokens: 0 };
  d.calls += calls;
  d.promptTokens += promptTokens;
  d.completionTokens += completionTokens;
  u[day] = d;
  // keep 30 days
  const days = Object.keys(u).sort();
  while (days.length > 30) delete u[days.shift()];
  await setMeta("usage", u);
}

// ------------------------------------------------------------- holdings
//
// The current book, synced from the vault's `type: holding` notes on a
// TTL (see sources/money.js's syncHoldings) rather than re-read on every
// 15-minute pull. This table is always the full current picture — call
// setHoldings with a fresh list and it replaces the old one wholesale, so
// a position you sold actually disappears instead of sitting there with
// shares that are no longer true.

export async function getHoldings() {
  const dbc = getDb();
  return dbc.prepare(`
    SELECT ticker, shares, currency, sector, bookValue, avgCost, source, updatedAt
    FROM holdings ORDER BY ticker
  `).all();
}

export async function setHoldings(holdings, source = null) {
  const dbc = getDb();
  const now = nowIso();
  dbc.exec("BEGIN");
  try {
    dbc.exec("DELETE FROM holdings");
    const ins = dbc.prepare(`
      INSERT INTO holdings (ticker, shares, currency, sector, bookValue, avgCost, source, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const h of holdings) {
      ins.run(
        h.ticker, h.shares, h.currency ?? null, h.sector ?? null,
        h.bookValue ?? null, h.avgCost ?? null, source, now
      );
    }
    dbc.exec("COMMIT");
  } catch (err) {
    dbc.exec("ROLLBACK");
    throw err;
  }
}

// ----------------------------------------------------- portfolio history
//
// One row per day for the total (unchanged shape from the old
// meta.portfolioHistory array), plus — new — one row per holding per day.
// No row cap: the old 400-row limit existed only to bound a single JSON
// blob's growth, and was quietly discarding history past ~400 days. A real
// table doesn't need that trade-off.

export async function recordPortfolioDay(date, { total, dayPct = null, dayValue = null, base = null } = {}) {
  const dbc = getDb();
  dbc.prepare(`
    INSERT INTO portfolio_days (date, total, dayPct, dayValue, base)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total = excluded.total,
      dayPct = excluded.dayPct,
      dayValue = excluded.dayValue,
      base = excluded.base
  `).run(date, total, dayPct, dayValue, base);
}

/** Same [{date, total, dayPct, dayValue}] shape the old meta blob returned. */
export async function portfolioHistory({ limit } = {}) {
  const dbc = getDb();
  const rows = limit
    ? dbc.prepare("SELECT date, total, dayPct, dayValue FROM portfolio_days ORDER BY date DESC LIMIT ?").all(limit).reverse()
    : dbc.prepare("SELECT date, total, dayPct, dayValue FROM portfolio_days ORDER BY date ASC").all();
  return rows.map((r) => ({ date: r.date, total: r.total, dayPct: r.dayPct, dayValue: r.dayValue }));
}

/**
 * New capability — this never existed before. One row per holding per day,
 * so "how did VFV do on the 20th" becomes a real query instead of a number
 * that was computed fresh on every pull and thrown away.
 */
export async function recordHoldingDay(date, ticker, {
  price = null, dayChangePct = null, dayChangeValue = null, shares = null, value = null, currency = null,
} = {}) {
  const dbc = getDb();
  dbc.prepare(`
    INSERT INTO holding_days (date, ticker, price, dayChangePct, dayChangeValue, shares, value, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, ticker) DO UPDATE SET
      price = excluded.price,
      dayChangePct = excluded.dayChangePct,
      dayChangeValue = excluded.dayChangeValue,
      shares = excluded.shares,
      value = excluded.value,
      currency = excluded.currency
  `).run(date, ticker, price, dayChangePct, dayChangeValue, shares, value, currency);
}

export async function holdingHistory(ticker, { limit } = {}) {
  const dbc = getDb();
  const cols = "date, ticker, price, dayChangePct, dayChangeValue, shares, value, currency";
  const rows = limit
    ? dbc.prepare(`SELECT ${cols} FROM holding_days WHERE ticker = ? ORDER BY date DESC LIMIT ?`).all(ticker, limit).reverse()
    : dbc.prepare(`SELECT ${cols} FROM holding_days WHERE ticker = ? ORDER BY date ASC`).all(ticker);
  return rows;
}
