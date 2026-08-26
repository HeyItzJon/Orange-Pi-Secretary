// brief/insights.js
//
// Everything DeepSeek writes FROM the day's real, already-collected events
// — as opposed to sources/email.js's use of the model, which writes FROM
// an email's own text. Two jobs, each one batched call so a normal 15-
// minute refresh cycle never costs more than two extra round-trips:
//
//   1. craftDayInsights()  — a one-line title for each carousel day
//      (Today plus the next 3) and a longer 2-3 sentence note for every
//      Week-page day (all 7), in the SAME call so a note can reference
//      another day ("get ahead for Friday's test") without a second
//      round-trip re-deriving the shape of the week.
//   2. organizeDeadlines() — renames each upcoming deadline into a
//      clearer, more actionable line and ranks it high/medium/low. The
//      CATEGORY grouping itself stays whatever the rules already decided
//      (see buildDeadlinePool in display.js) — same principle lib/ai.js's
//      own header comment states for the email classifier: the model
//      reads and writes, rules decide what a thing IS.
//
// Both degrade to null on any failure (missing key, provider down, a
// malformed response) — buildDisplay() already has a real, rule-based
// fallback for every one of these (daySummary(), fallbackWeekNote(), the
// un-renamed deadline pool), so a bad AI day never blanks the screen.
//
// Called once per compose cycle (see brief/compose.js's buildBrief()),
// never per /api/display request — see that route's own comment in
// server.js for why hitting it every minute has to stay free.

import { ask } from "../lib/ai.js";
import { cacheKey } from "../lib/ids.js";

const DAY_TITLE_SYSTEM = `You write two things for each day of a university student's (who also works part-time) week: a very short title and a longer note.

Return json with this exact shape:
{"days":[{"n":1,"title":"...","note":"..."}]}

Rules for "title":
- Ultra-short — aim for under 40 characters, never more than 55.
- Describe the SHAPE of the day, don't just list event names — e.g. "Two shifts and an early lab", "Heavy school day with one test", "Quiet morning, social evening downtown".
- Reference categories/patterns (shifts, class, test, social) rather than restating raw event titles when a pattern is obvious from more than one event.
- If the day is genuinely empty, say so plainly ("Wide open day").
- No emoji, no exclamation points, no generic filler ("Have a great day!").

Rules for "note":
- 1 to 3 sentences, conversational and specific to what's actually happening that day and, where useful, nearby days.
- Can be a plain description of the day's shape, OR a genuinely useful observation — using free time today to get ahead of a busier day coming up, a heads-up about back-to-back commitments, a suggestion to rest before an early start. Not every note has to be a recommendation.
- Never invent a plan, task, or event that isn't in the data given.
- No emoji, no generic filler, no "Have a great day!".

Only use the real events/busyness given for each day. Return exactly one result per day, in order, using the given "n".`;

function fmtDayForPrompt(day, i) {
  const lines = [`${i + 1}. ${day.label} (${day.dateLabel})${day.isToday ? " — TODAY" : ""}`];
  if (day.busyness != null) lines.push(`   Busyness: ${day.busyness}/10, ${day.loadPct ?? 0}% of waking hours booked`);
  if (day.allDay?.length) lines.push(`   All-day: ${day.allDay.join(", ")}`);
  if (day.timed?.length) {
    for (const e of day.timed) lines.push(`   - ${e.time}${e.end ? `–${e.end}` : ""} ${e.title} [${e.domain}]`);
  } else if (!day.allDay?.length) {
    lines.push("   Nothing scheduled.");
  }
  return lines.join("\n");
}

/**
 * One DeepSeek call for the whole week — `days` is buildDayContext()'s
 * output (Today + the next 6), in order. Returns a map keyed by each
 * day's own `key`, `{title, note}` — or null if the model didn't answer
 * (missing key, provider off, a malformed response) or `days` is empty.
 */
export async function craftDayInsights(days, config) {
  if (!days?.length) return null;

  const key = cacheKey(
    "day-insights",
    days.map((d) => ({ k: d.key, b: d.busyness, t: (d.timed || []).map((e) => `${e.time}${e.title}`), a: d.allDay }))
  );

  const parsed = await ask({
    system: DAY_TITLE_SYSTEM,
    user: `Return json for these ${days.length} days.\n\n${days.map(fmtDayForPrompt).join("\n\n")}`,
    config,
    maxTokens: 70 * days.length + 200,
    json: true,
    cacheAs: key,
  });
  if (!parsed?.days?.length) return null;

  const byN = new Map();
  for (const r of parsed.days) if (typeof r?.n === "number") byN.set(r.n, r);

  const out = {};
  days.forEach((d, i) => {
    const r = byN.get(i + 1);
    if (!r) return;
    out[d.key] = {
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 80) : null,
      note: typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 400) : null,
    };
  });
  return out;
}

const DEADLINE_SYSTEM = `You help a university student who also works part-time see their upcoming deadlines clearly. For each numbered item you receive, decide how to present it.

Return json with this exact shape:
{"results":[{"n":1,"title":"...","importance":"high"}]}

Rules:
- "title": a short, clear, actionable rewrite — say what it is and what's due, in plain language, under 60 characters. If the original is already a clean action, you can leave it close to as-is; don't invent detail that isn't given.
- "importance": "high" for anything genuinely bad to miss (a graded test, a payment, a hard deadline with real consequences), "low" for optional or soft items, "medium" for everything else.
- Return exactly one result per item, in order, using the given "n".`;

function fmtDeadlineForPrompt(item, i) {
  return [
    `${i + 1}. ${item.title}`,
    `   Category: ${item.categoryLabel || item.domain}`,
    `   Due: ${item.timeLabel}`,
  ].join("\n");
}

/**
 * One DeepSeek call across every deadline in `pool` (however
 * buildDeadlinePool() in display.js bucketed them by day) — returns a
 * flat Map keyed by item id, `{title, importance}`, so the caller can
 * re-merge each result back onto whichever day bucket its id came from.
 * Null if `pool` is empty or the model didn't answer.
 */
export async function organizeDeadlines(pool, config) {
  const items = Object.values(pool || {}).flat();
  if (!items.length) return null;

  const key = cacheKey("organize-deadlines", items.map((i) => `${i.id}:${i.title}:${i.dueAt}`).sort());

  const parsed = await ask({
    system: DEADLINE_SYSTEM,
    user: `Return json for these ${items.length} item(s).\n\n${items.map(fmtDeadlineForPrompt).join("\n\n")}`,
    config,
    maxTokens: 40 * items.length + 150,
    json: true,
    cacheAs: key,
  });
  if (!parsed?.results?.length) return null;

  const byN = new Map();
  for (const r of parsed.results) if (typeof r?.n === "number") byN.set(r.n, r);

  const out = new Map();
  items.forEach((item, i) => {
    const r = byN.get(i + 1);
    if (!r) return;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 80) : null;
    const importance = ["high", "medium", "low"].includes(r.importance) ? r.importance : null;
    if (title || importance) out.set(item.id, { title, importance });
  });
  return out;
}

/**
 * Runs both AI passes and returns exactly the shape buildDisplay()'s
 * `insights` param expects:
 *   { days: {[dayKey]: {title, note}} | null,
 *     deadlines: {[dayKey]: [{id, title, categoryLabel, domain, dueAt,
 *                             timeLabel, importance}]} | null }
 * `dayContext` is buildDayContext()'s output, `deadlinePool` is
 * buildDeadlinePool()'s. Either half can come back null independently —
 * a malformed day-titles response doesn't have to sink the deadline
 * rewrite too, and vice versa.
 *
 * Every renamed entry is merged ONTO its full original pool item — never
 * replaces it — so `domain`/`categoryLabel`/`timeLabel`/`dueAt` (the
 * Today page's dot colour and meta line have nothing else to read) always
 * survive, whether or not the model actually renamed that particular item.
 * An item the model didn't answer for (its own response was short, or
 * malformed for just that one entry) keeps its original rule-based
 * title/importance rather than being dropped from the list — the AI half
 * of this feature should only ever ADD polish on top of the real pool,
 * never subtract a genuine deadline from it.
 */
export async function refreshInsights({ dayContext, deadlinePool, config }) {
  const [days, renamed] = await Promise.all([
    craftDayInsights(dayContext, config),
    organizeDeadlines(deadlinePool, config),
  ]);

  let deadlines = null;
  if (renamed) {
    deadlines = {};
    for (const [dayKeyStr, items] of Object.entries(deadlinePool || {})) {
      deadlines[dayKeyStr] = items.map((it) => {
        const r = renamed.get(it.id);
        return {
          ...it,
          title: r?.title || it.title,
          importance: r?.importance || it.importance,
        };
      });
    }
  }

  return { days, deadlines };
}
