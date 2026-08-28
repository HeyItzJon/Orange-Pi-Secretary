// brief/compose.js
//
// Runs the sources, folds what they found into memory, then asks the rules
// what today's brief should say.
//
// The AI is optional here by design: if the key is missing, the provider is
// down, or you set provider "off", the brief still renders completely. The
// model only ever adds one summary sentence on top of a structure the rules
// already decided.

import { logger } from "../lib/log.js";
import { upsertMany, allItems, markSurfaced, getMeta, setMeta, prune } from "../lib/store.js";
import { ask } from "../lib/ai.js";
import { cacheKey } from "../lib/ids.js";
import { selectForBrief } from "./rules.js";
import { domainLabel } from "../lib/classify.js";
import { collectEmail } from "../sources/email.js";
import { collectCalendar } from "../sources/calendar.js";
import { collectMoney } from "../sources/money.js";
import { collectBrightspace } from "../sources/brightspace.js";
import { buildPriorities } from "./priorities.js";
import { buildDayContext, buildDeadlinePool } from "./display.js";
import { refreshInsights } from "./insights.js";
import { SOURCES } from "../lib/sources.js";

const log = logger("brief");

// The vault is no longer a task/event source (see lib/sources.js) — money.js
// still reads it directly for holdings, which is unrelated to this list.
// brightspace is always in the rotation, same as every other source — see
// sources/brightspace.js's own header for why running it with no ICS URL
// set yet is a harmless no-op rather than something that needs special-
// casing out of this list.
const COLLECTORS = {
  email: collectEmail,
  calendar: collectCalendar,
  money: collectMoney,
  brightspace: collectBrightspace,
};

/** The canonical source list. Everything that iterates sources reads this. */
export const SOURCE_NAMES = Object.keys(COLLECTORS);

/**
 * Refresh one or more sources. Each is isolated: a failure in email never
 * stops calendar from updating.
 */
export async function runSources(config, { only = null, force = false } = {}) {
  const names = only ? [only].flat() : Object.keys(COLLECTORS);
  const report = {};

  for (const name of names) {
    const fn = COLLECTORS[name];
    if (!fn) {
      report[name] = { ok: false, error: "unknown source" };
      continue;
    }
    const started = Date.now();
    try {
      // A collector returns an array, or {items, detail} when the count of
      // items is a bad summary of what it did — news fetches nine feeds and
      // produces zero items, and "found 0" would read as a failure.
      const raw = await fn(config, { force });
      const items = Array.isArray(raw) ? raw : raw?.items || [];
      const detail = Array.isArray(raw) ? null : raw?.detail || null;
      await upsertMany(items);
      report[name] = { ok: true, found: items.length, detail, ms: Date.now() - started };
      log.info(`${name}: ${detail || `${items.length} items`} in ${Date.now() - started}ms`);
      // Only a SUCCESSFUL fetch counts as "last run". Stamping this on failure
      // too meant a dead Gmail token still read as "just checked" — the always-on
      // screen would look healthy forever while showing yesterday.
      await setMeta(`lastRun_${name}`, new Date().toISOString());
      await setMeta(`lastError_${name}`, null);
    } catch (err) {
      report[name] = { ok: false, error: err.message, ms: Date.now() - started };
      log.error(`${name} failed: ${err.message}`);
      await setMeta(`lastError_${name}`, { at: new Date().toISOString(), message: err.message });
    }
    await setMeta(`lastAttempt_${name}`, new Date().toISOString());
  }

  return report;
}

const NARRATE_SYSTEM = `You write the opening line of a personal morning brief for a university student who also works part-time.

Return json: {"summary":"..."}

Rules:
- ONE sentence, under 140 characters.
- Name the single most important thing and, if useful, the shape of the day.
- Plain and direct. No greeting, no "here's your brief", no motivational filler, no emoji.
- If the day is genuinely quiet, say so plainly.
- Only use facts from the items given. Never invent a detail.`;

function itemsForNarration(sections, config) {
  const lines = [];
  for (const [key, list] of Object.entries(sections)) {
    if (!list?.length) continue;
    lines.push(`${key === "today" ? "Today" : domainLabel(key, config)}:`);
    for (const it of list.slice(0, 5)) {
      const d = it._daysUntil;
      const when = d === null || d === undefined ? "" : d <= 0 ? " (today)" : ` (in ${d}d)`;
      lines.push(`- ${it.title}${when}`);
    }
  }
  return lines.join("\n");
}

export async function buildBrief(config, { narrate = true, markAsSurfaced = true } = {}) {
  const now = new Date();
  const lastBriefAt = await getMeta("lastBriefAt", null);
  const items = await allItems();

  const { schema, sections, surfacedIds, counts, order, excluded } = selectForBrief(items, {
    now,
    lastBriefAt,
    config,
  });

  let summary = null;
  if (narrate && surfacedIds.length) {
    const key = cacheKey("narrate", { d: now.toISOString().slice(0, 13), ids: surfacedIds });
    const res = await ask({
      system: NARRATE_SYSTEM,
      user: `Today is ${now.toDateString()}. Return json.\n\n${itemsForNarration(sections, config)}`,
      config,
      maxTokens: 120,
      json: true,
      cacheAs: key,
    });
    summary = typeof res?.summary === "string" ? res.summary.trim() : null;
  }

  const moneySummary = await getMeta("moneySummary", null);

  // Cached against a hash of the open work, so the 15-minute pull cycle does
  // not mean 96 model calls a day — it only re-runs when the work changes.
  const priorities = await buildPriorities(items, { config, now });

  // Same story as priorities: computed here, once per compose cycle, and
  // cached (see brief/insights.js's own ask() calls) against a hash of the
  // day's real events/deadlines, never inside buildDisplay() itself — that
  // function is called on every /api/display poll, and this is the only
  // reason that route's own comment can still say hitting it every minute
  // is free. See brief/insights.js's header for what each half degrades to
  // when the model is off or unavailable.
  const insights = await refreshInsights({
    dayContext: buildDayContext(items, config, now),
    // Same 7-day window buildDisplay() itself now uses for rawDeadlinePool
    // (was 4 — the old carousel-only window) — see that file's own comment
    // for why: the Week page's per-day deadline count and Today's own
    // deadlines section both need the full week the AI pass covers here.
    deadlinePool: buildDeadlinePool(items, config, now, { days: 7 }),
    config,
  });

  const brief = {
    schema,
    generatedAt: now.toISOString(),
    previousBriefAt: lastBriefAt,
    timezone: config.timezone || "America/Toronto",
    summary,
    counts,
    order,
    excluded,
    domainLabels: Object.fromEntries((config.domains?.definitions || []).map((d) => [d.id, d.label])),
    sections,
    money: moneySummary,
    priorities: priorities.list,
    prioritiesFrom: priorities.source,
    insights,
    sources: Object.fromEntries(
      await Promise.all(
        SOURCES.map(async (s) => [s, await getMeta(`lastRun_${s}`, null)])
      )
    ),
  };

  if (markAsSurfaced && surfacedIds.length) {
    await markSurfaced(surfacedIds);
    await setMeta("lastBriefAt", now.toISOString());
  }
  await setMeta("lastBrief", brief);

  log.info(`brief: ${counts.total} shown (${counts.new} new, ${counts.quiet} quiet, ${counts.excluded} excluded)`);
  return brief;
}

/** Full cycle: refresh everything, then compose. Used by the scheduler. */
export async function runFullCycle(config, { force = false } = {}) {
  const report = await runSources(config, { force });
  const brief = await buildBrief(config, { narrate: true });
  await prune({
    maxAgeDays: config.brief?.retainDays ?? 90,
    brightspaceMaxPastDays: config.brightspace?.maxPastDays ?? 14,
  });
  return { report, brief };
}
