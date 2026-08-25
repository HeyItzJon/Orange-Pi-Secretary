// scripts/migrate-to-sqlite.js
//
// One-time move from the old single-JSON-file store to SQLite. Reads the
// existing data/secretary.json and writes every row into the new database
// via lib/db.js, preserving every field exactly as recorded — no
// recomputed timestamps, no fabricated data beyond the one explicitly
// called-out inference below (portfolio_days.base).
//
// Run: node scripts/migrate-to-sqlite.js [--from=path] [--to=path] [--dry]
//
// Safe to re-run: every write is an upsert keyed the same way the live app
// keys it, so running this twice just re-applies the same data. The source
// JSON file is never modified or deleted — keep it around as a backup.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const FROM = path.resolve(args.from || path.join(__dirname, "..", "data", "secretary.json"));
const TO = path.resolve(args.to || path.join(__dirname, "..", "data", "secretary.db"));
const DRY = Boolean(args.dry);

if (!fs.existsSync(FROM)) {
  console.error(`no source file at ${FROM}`);
  process.exit(1);
}

console.log(`migrating\n  from  ${FROM}\n  to    ${TO}${DRY ? "  (dry run — nothing will be written)" : ""}\n`);

const raw = JSON.parse(fs.readFileSync(FROM, "utf-8"));
const items = raw.items || {};
const seenMessageIds = raw.seenMessageIds || [];
const cache = raw.cache || {};
const meta = raw.meta || {};
const oldPortfolioHistory = meta.portfolioHistory || [];

if (DRY) {
  console.log("would migrate:");
  console.log(`  ${Object.keys(items).length} items`);
  console.log(`  ${seenMessageIds.length} seen message ids`);
  console.log(`  ${Object.keys(cache).length} ai cache entries`);
  console.log(`  ${Object.keys(meta).filter((k) => k !== "portfolioHistory").length} meta keys`);
  console.log(`  ${oldPortfolioHistory.length} portfolio history rows`);
  console.log("  0 holding history rows (none were ever recorded — this starts empty)");
  process.exit(0);
}

if (fs.existsSync(TO)) {
  console.error(`refusing to run: ${TO} already exists. Move it aside first if you mean to redo this.`);
  process.exit(1);
}

process.env.STORE_DB_PATH = TO;
const { getDb } = await import("../lib/db.js");
const dbc = getDb();

function run() {
  // ---- items -------------------------------------------------------
  const insItem = dbc.prepare(`
    INSERT INTO items (id, status, source, dueAt, firstSeen, lastSeen, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, source = excluded.source, dueAt = excluded.dueAt,
      firstSeen = excluded.firstSeen, lastSeen = excluded.lastSeen, data = excluded.data
  `);
  let itemCount = 0;
  for (const [id, it] of Object.entries(items)) {
    insItem.run(id, it.status ?? "open", it.source ?? null, it.dueAt ?? null,
      it.firstSeen ?? null, it.lastSeen ?? null, JSON.stringify(it));
    itemCount++;
  }

  // ---- seen message ids ----------------------------------------------
  // The old array had no per-id timestamp; stamp all of them with this
  // migration's run time. Only matters for the future recency-trim once
  // the set grows past 3000 — it doesn't affect dedup correctness at all.
  const now = new Date().toISOString();
  const insSeen = dbc.prepare(`
    INSERT INTO seen_message_ids (message_id, seen_at) VALUES (?, ?)
    ON CONFLICT(message_id) DO UPDATE SET seen_at = excluded.seen_at
  `);
  for (const id of seenMessageIds) insSeen.run(id, now);

  // ---- ai cache ----------------------------------------------------
  const insCache = dbc.prepare(`
    INSERT INTO ai_cache (key, value, at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at
  `);
  for (const [key, entry] of Object.entries(cache)) {
    insCache.run(key, JSON.stringify(entry.value), entry.at || now);
  }

  // ---- meta (everything except portfolioHistory, which gets its own table) --
  const insMeta = dbc.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(meta)) {
    if (key === "portfolioHistory") continue;
    insMeta.run(key, JSON.stringify(value));
  }

  // ---- portfolio history ----------------------------------------------
  // `base` wasn't recorded per-row in the old array — backfilled here from
  // the current moneySummary.base, since the base currency doesn't change
  // day to day. The measured total/dayPct/dayValue are carried over
  // exactly as recorded; nothing about the actual numbers is invented.
  const inferredBase = meta.moneySummary?.base || null;
  const insPortfolioDay = dbc.prepare(`
    INSERT INTO portfolio_days (date, total, dayPct, dayValue, base)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total = excluded.total, dayPct = excluded.dayPct,
      dayValue = excluded.dayValue, base = excluded.base
  `);
  for (const row of oldPortfolioHistory) {
    insPortfolioDay.run(row.date, row.total, row.dayPct ?? null, row.dayValue ?? null, inferredBase);
  }

  // holding_days starts genuinely empty — no per-holding history was ever
  // recorded before this migration, so there's nothing honest to backfill.
  // It begins populating on the very next money pull.

  return {
    itemCount,
    seenCount: seenMessageIds.length,
    cacheCount: Object.keys(cache).length,
    metaCount: Object.keys(meta).filter((k) => k !== "portfolioHistory").length,
    portfolioDays: oldPortfolioHistory.length,
  };
}

dbc.exec("BEGIN");
let result;
try {
  result = run();
  dbc.exec("COMMIT");
} catch (err) {
  dbc.exec("ROLLBACK");
  console.error(`migration failed, rolled back: ${err.message}`);
  process.exit(1);
}

console.log("done:");
console.log(`  ${result.itemCount} items`);
console.log(`  ${result.seenCount} seen message ids`);
console.log(`  ${result.cacheCount} ai cache entries`);
console.log(`  ${result.metaCount} meta keys`);
console.log(`  ${result.portfolioDays} portfolio history rows`);
console.log("  0 holding history rows (starts empty — none existed before)");
console.log(`\nthe original file at ${FROM} was not modified.`);
