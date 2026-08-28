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
    // Jon's own call: no single dismiss — his own click, or the system's own
    // "this looks gone" guess in sources/calendar.js — gets to be permanent
    // on the first try. See dismissItem() below for where a dismiss actually
    // gets recorded: every one counts a strike on the item, and only once
    // the SAME item has needed dismissing config.dismissal.afterCount times
    // does permanentlySuppressed lock it in for good. Below that count, a
    // dismissed item can still be revived right here — by the system's own
    // guess turning out wrong (autoDismissed, same idea as before), or now
    // also by the item's content genuinely changing since the dismiss: an
    // edited event or task is arguably a different ask than the one that
    // got dismissed, and deserves a fresh look rather than being silently
    // swallowed by an old dismiss on stale content. "done" is never touched
    // by any of this — finishing a task and then someone editing its
    // description doesn't un-finish it.
    const locked = Boolean(prev.permanentlySuppressed);
    const revive = !locked && prev.status === "dismissed" && (prev.autoDismissed || contentChanged);
    item = {
      ...prev,
      ...incoming,
      firstSeen: prev.firstSeen,
      lastSeen: now,
      status: revive ? "open" : prev.status,
      surfaceCount: prev.surfaceCount,
      lastSurfaced: prev.lastSurfaced,
      snoozeUntil: prev.snoozeUntil,
      // Carried forward explicitly, the same reason surfaceCount etc. are
      // above: this is persistent memory that has to survive every future
      // fetch regardless of what that fetch's own fresh `incoming` carries,
      // or the whole point of counting strikes across time (rather than
      // resetting the moment the item is naturally refetched) falls apart.
      dismissStrikes: prev.dismissStrikes || 0,
      permanentlySuppressed: locked,
      // Cleared the moment it's done its one job — deciding whether THIS
      // upsert should revive the item — so a stale "this was an auto-guess"
      // flag can't misattribute some later, separate dismissal (the user's
      // own, say) as another wrong guess.
      autoDismissed: false,
      // A changed item earns the right to be shown again — same as a
      // revived one: either way, this is new information worth resurfacing.
      changed: contentChanged || prev.changed || revive,
    };
  }
  writeItem(dbc, incoming.id, item);
  return item;
}

/**
 * The one way anything should ever get dismissed — your own click on the
 * Tasks page's ✕, or sources/calendar.js's reconciliation guessing an event
 * is gone. Every dismiss counts a strike on the item (persisted across
 * revivals — see upsertItem's own comment on why that has to be an explicit
 * top-level field rather than left inside a blob that gets overwritten by
 * the next fetch); only once `threshold` is reached does permanentlySuppressed
 * lock it in for good. `auto: true` is sources/calendar.js's own inferred
 * dismiss — the one kind upsertItem's revive check will undo on its own if
 * it turns out to be wrong; a real dismiss (auto: false) only comes back via
 * a genuine content change, never on its own.
 */
export async function dismissItem(id, { threshold = 3, auto = false } = {}) {
  const dbc = getDb();
  const prev = readItem(dbc, id);
  if (!prev) return null;
  const strikes = (prev.dismissStrikes || 0) + 1;
  const item = {
    ...prev,
    status: "dismissed",
    dismissStrikes: strikes,
    autoDismissed: auto,
    permanentlySuppressed: strikes >= threshold,
  };
  writeItem(dbc, id, item);
  return item;
}

/**
 * The explicit "no really, forever" lever — Jon's own alternative to waiting
 * out the strike count: skips straight to permanentlySuppressed regardless
 * of how many strikes the item has on record. Used by the /api/items
 * "suppress" action and scripts/force-dismiss.js's deliberate CLI dismiss.
 */
export async function suppressPermanently(id) {
  const dbc = getDb();
  const prev = readItem(dbc, id);
  if (!prev) return null;
  const item = { ...prev, status: "dismissed", permanentlySuppressed: true, autoDismissed: false };
  writeItem(dbc, id, item);
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

/**
 * Hard-remove a single item by id — an actual DELETE, not a status change.
 * No ongoing pull path calls this; a normal refresh only ever soft-dismisses
 * (see upsertItem's sticky status above). This exists for one-off manual
 * cleanup — see scripts/purge-ghosts.js — where a dismissed row needs to be
 * really gone rather than permanently hidden. Returns true if a row was
 * actually removed.
 */
export async function deleteItem(id) {
  const dbc = getDb();
  const result = dbc.prepare("DELETE FROM items WHERE id = ?").run(id);
  return result.changes > 0;
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
export async function prune({ maxAgeDays = 90, brightspaceMaxPastDays = 14 } = {}) {
  const dbc = getDb();
  const cutoffIso = new Date(Date.now() - maxAgeDays * 86400000).toISOString();

  const result = dbc.prepare(`
    DELETE FROM items
    WHERE COALESCE(lastSeen, firstSeen) < ?
      AND (status IN ('done', 'dismissed') OR dueAt IS NULL)
  `).run(cutoffIso);
  let removed = result.changes;

  // Brightspace is the one source whose feed routinely spans a student's
  // ENTIRE enrollment history (see sources/brightspace.js), so an old item
  // never earns 'done'/'dismissed' the way everything else does — nobody
  // goes back and marks a two-year-old assignment done. Without this, the
  // rule above never touches it and it stays 'open' forever. Safe to just
  // delete outright (not a status change): Brightspace is documented as a
  // secondary, disposable source, never the primary record of anything —
  // losing an old, unmatched entry here loses nothing the app actually
  // relies on. sources/brightspace.js's own collector already stops
  // re-adding items this old going forward; this is what clears out
  // whatever already accumulated before that filter existed.
  const bsCutoffIso = new Date(Date.now() - brightspaceMaxPastDays * 86400000).toISOString();
  const bsResult = dbc.prepare(`
    DELETE FROM items
    WHERE source = 'brightspace' AND status = 'open' AND dueAt IS NOT NULL AND dueAt < ?
  `).run(bsCutoffIso);
  removed += bsResult.changes;

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

// ------------------------------------------------------------- courses
//
// Syllabus reference data — see db.js's own comment on the `courses` table.
// Same getX/setX shape as getHoldings()/setHoldings() above: the caller
// never sees that weightings/topics are stored as JSON text, only the
// parsed arrays it actually wants to read or write.

export async function getCourse(courseCode) {
  const dbc = getDb();
  const row = dbc.prepare("SELECT * FROM courses WHERE course_code = ?").get(courseCode);
  if (!row) return null;
  return {
    courseCode: row.course_code,
    courseName: row.course_name || null,
    weightings: row.weightings ? JSON.parse(row.weightings) : [],
    topics: row.topics ? JSON.parse(row.topics) : [],
    syllabusFile: row.syllabus_file || null,
    syllabusHash: row.syllabus_hash || null,
    updatedAt: row.updated_at || null,
  };
}

export async function setCourse(courseCode, {
  courseName = null, weightings = [], topics = [], syllabusFile = null, syllabusHash = null,
} = {}) {
  const dbc = getDb();
  dbc.prepare(`
    INSERT INTO courses (course_code, course_name, weightings, topics, syllabus_file, syllabus_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(course_code) DO UPDATE SET
      course_name = excluded.course_name,
      weightings = excluded.weightings,
      topics = excluded.topics,
      syllabus_file = excluded.syllabus_file,
      syllabus_hash = excluded.syllabus_hash,
      updated_at = excluded.updated_at
  `).run(
    courseCode, courseName, JSON.stringify(weightings), JSON.stringify(topics),
    syllabusFile, syllabusHash, nowIso()
  );
}

export async function allCourses() {
  const dbc = getDb();
  return dbc.prepare("SELECT course_code FROM courses ORDER BY course_code").all().map((r) => r.course_code);
}
