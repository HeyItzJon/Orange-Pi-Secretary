// store.js
//
// The memory. Everything the secretary knows persists here.
//
// Deliberately zero-dependency: a single JSON file, written atomically
// (temp file + rename, so a power cut on the Pi can never leave a
// half-written file), guarded by an in-process mutex so the scheduler and a
// manual refresh can't clobber each other. That mutex is the fix for the v1
// bug where overlapping runs silently lost data.
//
// Scale check: one user, a few thousand items over years. A JSON file is the
// right tool. If this ever outgrows it, swap this one module for node:sqlite
// (Node 22+) — nothing else in the codebase knows how storage works.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./log.js";

const log = logger("store");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "secretary.json");

const EMPTY = {
  version: 2,
  items: {},          // id -> item
  seenMessageIds: [], // Gmail message ids already processed (cheap dedup)
  cache: {},          // ai classification cache: key -> { value, at }
  meta: {},           // lastBriefAt, usage counters, calendar list cache, ...
};

let db = null;
let chain = Promise.resolve(); // mutex

/** Serialise every mutation through one promise chain. */
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function readFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`could not read db (${err.message}) — starting fresh`);
    return structuredClone(EMPTY);
  }
}

async function writeToDisk() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmp, DB_PATH); // atomic on the same filesystem
}

async function ensure() {
  if (!db) db = await readFromDisk();
  return db;
}

export async function init() {
  return withLock(async () => {
    await ensure();
    log.info(`loaded ${Object.keys(db.items).length} items`);
    return db;
  });
}

// ---------------------------------------------------------------- items

/**
 * Insert or update an item, preserving everything the system has learned
 * about it — first_seen, how many times you've been told, whether you
 * dismissed it. This is the heart of "don't repeat yourself".
 */
export async function upsertItem(incoming) {
  return withLock(async () => {
    await ensure();
    const now = new Date().toISOString();
    const prev = db.items[incoming.id];

    if (!prev) {
      db.items[incoming.id] = {
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
      db.items[incoming.id] = {
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
    await writeToDisk();
    return db.items[incoming.id];
  });
}

export async function upsertMany(items) {
  const out = [];
  for (const it of items) out.push(await upsertItem(it));
  return out;
}

export async function allItems() {
  await withLock(ensure);
  return Object.values(db.items);
}

export async function getItem(id) {
  await withLock(ensure);
  return db.items[id] || null;
}

export async function patchItem(id, fields) {
  return withLock(async () => {
    await ensure();
    if (!db.items[id]) return null;
    db.items[id] = { ...db.items[id], ...fields };
    await writeToDisk();
    return db.items[id];
  });
}

/** Record that these items went out in a brief — drives suppression. */
export async function markSurfaced(ids) {
  return withLock(async () => {
    await ensure();
    const now = new Date().toISOString();
    for (const id of ids) {
      const it = db.items[id];
      if (!it) continue;
      it.surfaceCount = (it.surfaceCount || 0) + 1;
      it.lastSurfaced = now;
      it.changed = false; // the change has now been reported
    }
    await writeToDisk();
  });
}

/** Drop resolved/expired items so the file doesn't grow without bound. */
export async function prune({ maxAgeDays = 90 } = {}) {
  return withLock(async () => {
    await ensure();
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let removed = 0;
    for (const [id, it] of Object.entries(db.items)) {
      const stamp = new Date(it.lastSeen || it.firstSeen).getTime();
      const closed = it.status === "done" || it.status === "dismissed";
      if (stamp < cutoff && (closed || !it.dueAt)) {
        delete db.items[id];
        removed++;
      }
    }
    if (db.seenMessageIds.length > 3000) {
      db.seenMessageIds = db.seenMessageIds.slice(-2000);
    }
    for (const [k, v] of Object.entries(db.cache)) {
      if (Date.now() - new Date(v.at).getTime() > 30 * 86400000) delete db.cache[k];
    }
    if (removed) log.info(`pruned ${removed} items`);
    await writeToDisk();
    return removed;
  });
}

// ------------------------------------------------- gmail message id dedup

export async function knownMessageIds() {
  await withLock(ensure);
  return new Set(db.seenMessageIds);
}

export async function rememberMessageIds(ids) {
  return withLock(async () => {
    await ensure();
    const set = new Set(db.seenMessageIds);
    for (const id of ids) set.add(id);
    db.seenMessageIds = [...set];
    await writeToDisk();
  });
}

// ------------------------------------------------------------- ai cache

export async function cacheGet(key) {
  await withLock(ensure);
  return db.cache[key]?.value ?? null;
}

export async function cacheSet(key, value) {
  return withLock(async () => {
    await ensure();
    db.cache[key] = { value, at: new Date().toISOString() };
    await writeToDisk();
  });
}

// ----------------------------------------------------------------- meta

export async function getMeta(key, fallback = null) {
  await withLock(ensure);
  return db.meta[key] ?? fallback;
}

export async function setMeta(key, value) {
  return withLock(async () => {
    await ensure();
    db.meta[key] = value;
    await writeToDisk();
  });
}

/** Running tally of what the AI has cost us. Visible at /api/usage. */
export async function addUsage({ calls = 0, promptTokens = 0, completionTokens = 0 }) {
  return withLock(async () => {
    await ensure();
    const day = new Date().toISOString().slice(0, 10);
    const u = db.meta.usage || {};
    const d = u[day] || { calls: 0, promptTokens: 0, completionTokens: 0 };
    d.calls += calls;
    d.promptTokens += promptTokens;
    d.completionTokens += completionTokens;
    u[day] = d;
    // keep 30 days
    const days = Object.keys(u).sort();
    while (days.length > 30) delete u[days.shift()];
    db.meta.usage = u;
    await writeToDisk();
  });
}
