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
import { selectForBrief, SECTION_LABELS, daysUntil } from "./rules.js";
import { collectEmail } from "../sources/email.js";
import { collectCalendar } from "../sources/calendar.js";
import { collectMoney } from "../sources/money.js";
import { collectNotes } from "../sources/notes.js";

const log = logger("brief");

const COLLECTORS = {
  email: collectEmail,
  calendar: collectCalendar,
  money: collectMoney,
  notes: collectNotes,
};

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
      const items = await fn(config, { force });
      await upsertMany(items);
      report[name] = { ok: true, found: items.length, ms: Date.now() - started };
      log.info(`${name}: ${items.length} items in ${Date.now() - started}ms`);
    } catch (err) {
      report[name] = { ok: false, error: err.message, ms: Date.now() - started };
      log.error(`${name} failed: ${err.message}`);
    }
    await setMeta(`lastRun_${name}`, new Date().toISOString());
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

function itemsForNarration(sections) {
  const lines = [];
  for (const [key, list] of Object.entries(sections)) {
    if (!list?.length) continue;
    lines.push(`${SECTION_LABELS[key]}:`);
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

  const { sections, surfacedIds, counts } = selectForBrief(items, {
    now,
    lastBriefAt,
    config,
  });

  let summary = null;
  if (narrate && surfacedIds.length) {
    const key = cacheKey("narrate", { d: now.toISOString().slice(0, 13), ids: surfacedIds });
    const res = await ask({
      system: NARRATE_SYSTEM,
      user: `Today is ${now.toDateString()}. Return json.\n\n${itemsForNarration(sections)}`,
      config,
      maxTokens: 120,
      json: true,
      cacheAs: key,
    });
    summary = typeof res?.summary === "string" ? res.summary.trim() : null;
  }

  const moneySummary = await getMeta("moneySummary", null);

  const brief = {
    generatedAt: now.toISOString(),
    previousBriefAt: lastBriefAt,
    timezone: config.timezone || "America/Toronto",
    summary,
    counts,
    sections,
    money: moneySummary,
    sources: Object.fromEntries(
      await Promise.all(
        ["email", "calendar", "money", "notes"].map(async (s) => [s, await getMeta(`lastRun_${s}`, null)])
      )
    ),
  };

  if (markAsSurfaced && surfacedIds.length) {
    await markSurfaced(surfacedIds);
    await setMeta("lastBriefAt", now.toISOString());
  }
  await setMeta("lastBrief", brief);

  log.info(`brief: ${counts.total} items (${counts.new} new, ${counts.hidden} held back)`);
  return brief;
}

/** Full cycle: refresh everything, then compose. Used by the scheduler. */
export async function runFullCycle(config, { force = false } = {}) {
  const report = await runSources(config, { force });
  const brief = await buildBrief(config, { narrate: true });
  await prune({ maxAgeDays: config.brief?.retainDays ?? 90 });
  return { report, brief };
}
