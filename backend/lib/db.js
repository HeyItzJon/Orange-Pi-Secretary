// db.js
//
// The connection. One SQLite file, opened lazily so tests can point it
// somewhere else (STORE_DB_PATH) before the first call touches disk.
//
// Why SQLite instead of the old JSON-blob-plus-mutex: every write here is a
// single synchronous statement against the database file itself — there's
// no in-memory snapshot that a second overlapping call could clobber, which
// is the whole reason the old store.js needed a hand-rolled mutex. WAL mode
// plus a real file gives us the power-cut durability the old temp+rename
// dance was for, for free.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./log.js";

const log = logger("db");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "secretary.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT,
  dueAt TEXT,
  firstSeen TEXT,
  lastSeen TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_dueAt ON items(dueAt);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);

CREATE TABLE IF NOT EXISTS seen_message_ids (
  message_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The current book: one row per position, replaced wholesale on every
-- vault sync (see sources/money.js's syncHoldings) rather than patched, so
-- a sold-out ticker disappears instead of lingering with stale shares.
-- Separate from holding_days, which is a growing daily history.
CREATE TABLE IF NOT EXISTS holdings (
  ticker TEXT PRIMARY KEY,
  shares REAL NOT NULL,
  currency TEXT,
  sector TEXT,
  bookValue REAL,
  avgCost REAL,
  source TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_days (
  date TEXT PRIMARY KEY,
  total REAL NOT NULL,
  dayPct REAL,
  dayValue REAL,
  base TEXT
);

CREATE TABLE IF NOT EXISTS holding_days (
  date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  price REAL,
  dayChangePct REAL,
  dayChangeValue REAL,
  shares REAL,
  value REAL,
  currency TEXT,
  PRIMARY KEY (date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_holding_days_ticker ON holding_days(ticker);

-- Syllabus reference data, one row per course — grade weightings and topic
-- scope, extracted once (and only re-extracted when the PDF's own content
-- hash changes) by scripts/parse-syllabus.js. Deliberately separate from
-- items: a course's grading breakdown isn't a task with a due date, it's
-- context that enriches whichever Brightspace/calendar items mention that
-- course code (see brief/detail.js's buildFacts()). weightings/topics are
-- stored as JSON text, same convention as items.data — this table never
-- needs to be queried BY their contents, only read back whole.
CREATE TABLE IF NOT EXISTS courses (
  course_code   TEXT PRIMARY KEY,
  course_name   TEXT,
  weightings    TEXT,
  topics        TEXT,
  syllabus_file TEXT,
  syllabus_hash TEXT,
  updated_at    TEXT
);
`;

let instance = null;
let instancePath = null;

/**
 * Lazy singleton. Reads STORE_DB_PATH on first call so tests can redirect
 * storage before anything connects — set the env var, then call getDb() (or
 * anything in store.js, which calls this internally) for the first time.
 */
export function getDb() {
  const target = process.env.STORE_DB_PATH || DEFAULT_DB_PATH;

  // A test suite that changes STORE_DB_PATH between runs (e.g. a fresh temp
  // file per test file) should get a fresh connection, not the old one.
  if (instance && instancePath !== target) {
    try {
      instance.close();
    } catch {
      // already closed / never opened — fine
    }
    instance = null;
  }

  if (instance) return instance;

  if (target !== ":memory:") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  instance = new DatabaseSync(target);
  // WAL needs a shared-memory-mapped -shm file alongside the db, which not
  // every filesystem this app might sit on supports (network shares, some
  // bind-mounted/virtualized folders). It's a nice-to-have for concurrent
  // read performance, not a requirement — this app has at most a couple of
  // writers at a time, which SQLite's default rollback journal already
  // serializes safely. Try WAL; fall back quietly if the filesystem can't
  // do it rather than letting startup fail over a journal mode choice.
  try {
    instance.exec("PRAGMA journal_mode = WAL");
  } catch (err) {
    log.warn(`WAL journal mode unavailable here (${err.message}) — using the default rollback journal instead`);
  }
  instance.exec("PRAGMA synchronous = NORMAL");
  instance.exec(SCHEMA);
  instancePath = target;

  log.info(`connected (${target === ":memory:" ? "in-memory" : target})`);
  return instance;
}

/** Test-only escape hatch: force the next getDb() to open a fresh file. */
export function closeDb() {
  if (instance) {
    try {
      instance.close();
    } catch {
      // ignore
    }
  }
  instance = null;
  instancePath = null;
}
