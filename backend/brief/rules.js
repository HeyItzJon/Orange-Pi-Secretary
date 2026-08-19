// brief/rules.js
//
// What gets said, and how loudly. Pure functions, no network, no AI —
// which means this is the part you can actually test, tune and trust.
//
// Four jobs:
//   urgency()  — the clock. Same item, different volume as a date approaches.
//   rank()     — ONE transparent score per item, with a receipt. v1 sorted by
//                a flat "priority" that mixed importance and urgency together,
//                so ties were everywhere and nothing explained itself.
//   assign()   — every item lands in exactly ONE section, so nothing is said
//                twice in the same brief.
//   suppress() — once you've been told enough times, and nothing changed, and
//                nothing is close, stop saying it.

import { rankItem } from "../lib/classify.js";

export const SECTIONS = ["today", "needsYou", "newSince", "comingUp", "money", "looseThreads"];

export const SECTION_LABELS = {
  today: "Today",
  needsYou: "Needs you",
  newSince: "New since yesterday",
  comingUp: "Coming up",
  money: "Money",
  looseThreads: "Loose threads",
};

const DAY = 86400000;

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
 * whole backlog is treated as baseline. Without this, day one dumps every
 * item you own into "New since yesterday" and the section means nothing.
 */
export function isNew(item, lastBriefAt) {
  if (!lastBriefAt) return false;
  return new Date(item.firstSeen) > new Date(lastBriefAt);
}

function needsAction(item, u) {
  if (item.source === "email" && item.meta?.needsReply) return true;
  if (item.kind === "conflict") return true;
  if (item.kind === "contribution") return true;
  if (u === "critical" || u === "serious") return true;
  return false;
}

/**
 * Have we said this enough? An item earns silence once it has been surfaced
 * repeatedly, hasn't changed, and isn't close to a deadline.
 */
export function suppress(item, u, cfg) {
  const max = cfg.maxRepeats ?? 6;
  if (item.changed) return false;
  if (u) return false;                       // a clock running keeps its voice
  if (item.unmissable || item.emphasised) return false; // you flagged it yourself
  return (item.surfaceCount || 0) >= max;
}

function sectionFor(item, { u, fresh }) {
  if (item.source === "money") return "money";
  if (item.source === "note") return "looseThreads";
  if (item.kind === "system") return "needsYou";
  if (item.kind === "today") return "today";
  if (fresh && u !== "critical") return "newSince";
  if (needsAction(item, u)) return "needsYou";
  if (item.dueAt) return "comingUp";
  return null;
}

/**
 * Select and arrange everything for one brief.
 * Returns { sections, surfacedIds, counts }.
 */
export function selectForBrief(items, { now = new Date(), lastBriefAt = null, config = {} } = {}) {
  const cfg = config.brief || {};
  const horizon = cfg.comingUpDays ?? 14;
  const perSection = cfg.maxPerSection ?? 6;

  const buckets = Object.fromEntries(SECTIONS.map((s) => [s, []]));

  for (const raw of items) {
    if (!isActive(raw, now)) continue;

    const u = urgency(raw, now);
    const fresh = isNew(raw, lastBriefAt);
    const dLeft = daysUntil(raw, now);

    // Beyond the horizon it stays quiet until it gets closer.
    if (dLeft !== null && dLeft > horizon && raw.kind !== "today") continue;

    // Past events are history, not news.
    if (dLeft !== null && dLeft < -1 && raw.source === "calendar") continue;

    if (!fresh && suppress(raw, u, cfg)) continue;

    const section = sectionFor(raw, { u, fresh });
    if (!section) continue;

    const { score, why } = rankItem({ ...raw, changed: raw.changed || fresh }, { now, config });

    buckets[section].push({
      ...raw,
      _urgency: u,
      _new: fresh,
      _changed: Boolean(raw.changed),
      _daysUntil: dLeft,
      _rank: score,
      _rankWhy: why,
    });
  }

  // Today reads chronologically — it's a schedule, not a ranking.
  buckets.today.sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0));

  // Everything else reads by rank, with the deadline breaking ties.
  for (const s of SECTIONS) {
    if (s === "today") continue;
    buckets[s].sort((a, b) => {
      if (b._rank !== a._rank) return b._rank - a._rank;
      if (a.dueAt && b.dueAt) return new Date(a.dueAt) - new Date(b.dueAt);
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return String(a.title).localeCompare(String(b.title));
    });
  }

  const sections = {};
  const surfacedIds = [];
  for (const s of SECTIONS) {
    const capped = s === "today" ? buckets[s] : buckets[s].slice(0, perSection);
    if (capped.length) {
      sections[s] = capped;
      surfacedIds.push(...capped.map((i) => i.id));
    }
  }

  return {
    sections,
    surfacedIds,
    counts: {
      total: surfacedIds.length,
      new: Object.values(sections).flat().filter((i) => i._new).length,
      hidden: items.filter((i) => isActive(i, now)).length - surfacedIds.length,
    },
  };
}
