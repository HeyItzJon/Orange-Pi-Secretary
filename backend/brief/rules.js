// brief/rules.js
//
// What gets said, where it goes, and how loudly. Pure functions, no network,
// no AI — which means this is the part you can actually test, tune and trust.
//
// LAYOUT MODEL
//
//   Today   — a chronological timeline of the whole day, every domain mixed,
//             because that's what a schedule IS. Each row is tagged with its
//             domain so "work 12–5" and "BBQ at 6" read as different kinds of
//             thing without being separated.
//
//   Lanes   — everything that ISN'T today, grouped by area of life: School,
//             Work, Career, Finance, Social, Projects, Personal. This is where
//             you go to focus on one thing.
//
// An item appears in exactly one place. Today owns today; the lanes own the
// rest. Time is expressed as chips and ordering, not as its own sections.

import { rankItem, deriveDomain } from "../lib/classify.js";

const DAY = 86400000;

/**
 * Shape version. The frontend checks this and shows a "rebuild me" banner if
 * it doesn't recognise the value.
 *
 * This exists because a stale `frontend/dist` against a fresh backend fails
 * silently and looks exactly like data loss: the old bundle asks for sections
 * that no longer exist, renders almost nothing, and there's no error anywhere
 * to tell you the build is old. Bump this whenever `sections` changes shape.
 */
export const SCHEMA = "lanes-v1";

export const DEFAULT_DOMAIN_ORDER = [
  "school", "work", "career", "finance", "social", "projects", "personal",
];

export function domainOrder(config = {}) {
  return config.domains?.order || DEFAULT_DOMAIN_ORDER;
}

export function sectionKeys(config = {}) {
  return ["today", ...domainOrder(config)];
}

/** null | "warning" | "serious" | "critical" */
export function urgency(item, now = new Date()) {
  if (!item.dueAt) return null;
  const days = (new Date(item.dueAt).getTime() - now.getTime()) / DAY;
  if (days < 0) return "critical";
  if (days <= 1) return "critical";
  if (days <= 3) return "serious";
  if (days <= 7) return "warning";
  return null;
}

export function daysUntil(item, now = new Date()) {
  if (!item.dueAt) return null;
  return Math.round((new Date(item.dueAt).getTime() - now.getTime()) / DAY);
}

export function isActive(item, now = new Date()) {
  if (item.status === "dismissed" || item.status === "done") return false;
  if (item.status === "snoozed" && item.snoozeUntil && new Date(item.snoozeUntil) > now) return false;
  return true;
}

/**
 * "New" means: appeared since the last brief went out.
 *
 * On the very first brief there is no "since" — so nothing is new, and the
 * whole backlog is treated as baseline. Without this, day one marks every
 * item you own as new and the flag means nothing.
 */
export function isNew(item, lastBriefAt) {
  if (!lastBriefAt) return false;
  return new Date(item.firstSeen) > new Date(lastBriefAt);
}

export function needsAction(item, u = null) {
  if (item.source === "email" && item.meta?.needsReply) return true;
  if (item.kind === "contribution") return true;
  if (item.kind === "system") return true;
  if (u === "critical" || u === "serious") return true;
  return false;
}

/**
 * Have we said this enough?
 *
 * IMPORTANT: this no longer removes anything. An item that has been repeated
 * often, hasn't changed, and has no deadline gets marked QUIET — it still
 * appears in its lane, collapsed behind a "show N quieter" toggle you can
 * open. Nothing is ever silently withheld.
 */
export function isQuiet(item, u, cfg) {
  const max = cfg.maxRepeats ?? 6;
  if (item.changed) return false;
  if (u) return false;                                  // a running clock keeps its voice
  if (item.unmissable || item.emphasised) return false; // you flagged it yourself
  return (item.surfaceCount || 0) >= max;
}

/** @deprecated kept so older callers don't break; use isQuiet. */
export const suppress = isQuiet;

/** Fall back to deriving a domain for items stored before domains existed. */
function domainOf(item, config) {
  return item.domain || deriveDomain(
    { title: item.title, body: item.detail, category: item.category, path: item.meta?.path },
    config
  );
}

/**
 * Select and arrange everything for one brief.
 * Returns { sections, surfacedIds, counts, order }.
 */
export function selectForBrief(items, { now = new Date(), lastBriefAt = null, config = {} } = {}) {
  const cfg = config.brief || {};
  const horizon = cfg.horizonDays ?? cfg.comingUpDays ?? 60;
  const order = domainOrder(config);

  const buckets = { today: [] };
  for (const d of order) buckets[d] = [];
  const excluded = []; // everything NOT shown, with the reason — never silent

  for (const raw of items) {
    const u = urgency(raw, now);
    const fresh = isNew(raw, lastBriefAt);
    const dLeft = daysUntil(raw, now);

    // The only three things that remove an item from the brief entirely.
    // Each is either your explicit instruction or genuinely stale.
    if (raw.status === "done") { excluded.push({ id: raw.id, title: raw.title, why: "you marked it done" }); continue; }
    if (raw.status === "dismissed") { excluded.push({ id: raw.id, title: raw.title, why: "you dismissed it" }); continue; }
    if (raw.status === "snoozed" && raw.snoozeUntil && new Date(raw.snoozeUntil) > now) {
      excluded.push({ id: raw.id, title: raw.title, why: `snoozed until ${String(raw.snoozeUntil).slice(0, 10)}` });
      continue;
    }
    if (dLeft !== null && dLeft < -1 && raw.source === "calendar") {
      excluded.push({ id: raw.id, title: raw.title, why: `already happened (${Math.abs(dLeft)}d ago)` });
      continue;
    }
    if (dLeft !== null && dLeft > horizon && raw.kind !== "today") {
      excluded.push({ id: raw.id, title: raw.title, why: `more than ${horizon} days out` });
      continue;
    }

    const domain = domainOf(raw, config);
    const target = raw.kind === "today" ? "today" : domain;
    if (!buckets[target]) {
      excluded.push({ id: raw.id, title: raw.title, why: `unknown domain "${domain}" — check config` });
      continue;
    }

    const { score, why } = rankItem({ ...raw, changed: raw.changed || fresh }, { now, config });

    buckets[target].push({
      ...raw,
      domain,
      _urgency: u,
      _new: fresh,
      _changed: Boolean(raw.changed),
      _needsAction: needsAction(raw, u),
      // Quiet items still ship — the UI collapses them behind a toggle.
      _quiet: !fresh && isQuiet(raw, u, cfg),
      _daysUntil: dLeft,
      _rank: score,
      _rankWhy: why,
    });
  }

  // Today is a schedule, so it reads by the clock.
  buckets.today.sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0));

  // Lanes read by rank, with the nearer deadline breaking ties.
  for (const d of order) {
    buckets[d].sort((a, b) => {
      if (b._rank !== a._rank) return b._rank - a._rank;
      if (a.dueAt && b.dueAt) return new Date(a.dueAt) - new Date(b.dueAt);
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return String(a.title).localeCompare(String(b.title));
    });
  }

  // No truncation. Every item that survived the three exclusion rules above
  // ships to the client; the UI decides how much to show at once.
  const sections = {};
  const surfacedIds = [];
  for (const key of ["today", ...order]) {
    if (buckets[key].length) {
      sections[key] = buckets[key];
      surfacedIds.push(...buckets[key].map((i) => i.id));
    }
  }

  // Counts describe the LANES only. Today is never filtered — it's the
  // schedule — so counting it here would make the masthead disagree with
  // the filter chips, and a number that doesn't match its own button is
  // worse than no number.
  const laneItems = order.flatMap((d) => sections[d] || []);
  return {
    schema: SCHEMA,
    sections,
    order,
    surfacedIds,
    excluded,
    counts: {
      total: surfacedIds.length,
      today: (sections.today || []).length,
      lanes: laneItems.length,
      new: laneItems.filter((i) => i._new || i._changed).length,
      needsAction: laneItems.filter((i) => i._needsAction).length,
      quiet: laneItems.filter((i) => i._quiet).length,
      excluded: excluded.length,
    },
  };
}
