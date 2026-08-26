// brief/detail.js
//
// On-demand, per-item AI detail — deliberately NOT part of the once-per-
// compose insights pipeline (see brief/insights.js's own header for why
// THAT one has to run automatically, batched, every cycle). This is the
// opposite shape on purpose: nothing here ever runs unless a person
// actually taps one specific item to expand it, so a Today page nobody
// taps through costs nothing beyond the already-free /api/display poll —
// Jon's own call: "I don't wanna waste API calls if I'm not gonna click on
// any of these."
//
// Cost control is entirely lib/ai.js's own ask() cacheAs mechanism, not
// anything new built here — a second click on the same item, or the same
// item surviving unchanged to a later click (same contentHash), returns
// the cached answer for free; only a genuinely new question (a new item,
// or the same item's content actually changing) pays for a real call.
//
// Called only from server.js's GET /api/items/:id/detail — never from
// brief/compose.js, and never on a timer.

import { ask } from "../lib/ai.js";
import { cacheKey } from "../lib/ids.js";
import { clockLabel, durationLabel, priorityWord, importanceOf } from "./display.js";

const ORIGIN_LABELS = { calendar: "Calendar", email: "Email", brightspace: "Brightspace", money: "Finance" };

const KINDS = new Set(["event", "deadline", "allday"]);

/**
 * Which of the three UI treatments this click came from — the Today page's
 * timed events list, its Deadlines section, or its all-day chip row (see
 * Display.jsx). The frontend already knows which list a click landed in, so
 * it passes that as `hintKind`; this is only the fallback for when it
 * doesn't (an older client, a direct API hit) — a best guess from the item
 * itself, which can't always tell the two apart. A calendar all-day item
 * that's ALSO task-like (e.g. "Library books due") is a real example: it
 * shows up in both the all-day chip row AND the Deadlines list, and the two
 * clicks deserve different framing even though it's the same stored item.
 */
function inferKind(item) {
  if (item.meta?.allDay) return "allday";
  if (item.source === "calendar") return "event";
  return "deadline";
}

/**
 * Deterministic, no AI — always present in the response even when the
 * model is off, unavailable, or came back unparseable, so a click never
 * shows a blank panel, only a panel with a plainer summary underneath it.
 *
 * `swatch`/`color` carry the item's own real calendar colour (see
 * calendar.js: every calendar-sourced item — timed or all-day — already
 * stores these) so the modal's header dot can match the calendar it's
 * actually on, the same way the day strip and week bars already do,
 * rather than the broader life-area `domain` palette Tasks/Deadlines use.
 * `importance` is the same deterministic high/medium/low buildDeadlinePool
 * itself computes (see importanceOf() in display.js) — recomputed here
 * from the raw item since this endpoint never has that day's whole pool
 * built, just the one clicked item.
 */
function buildFacts(item, tz) {
  const allDay = Boolean(item.meta?.allDay);
  return {
    title: item.title,
    domain: item.domain || "personal",
    categoryLabel: item.categoryLabel || null,
    status: item.status || "open",
    dueAt: item.dueAt || null,
    when: item.dueAt ? (allDay ? "All day" : clockLabel(item.dueAt, tz)) : null,
    duration: !allDay && item.dueAt && item.meta?.end ? durationLabel(item.dueAt, item.meta.end, false) : null,
    where: item.meta?.location || null,
    attendees: item.meta?.attendees > 1 ? item.meta.attendees : null,
    source: item.source,
    sourceLabel: ORIGIN_LABELS[item.source] || item.source,
    from: item.meta?.from || null,
    url: item.url || null,
    priority: priorityWord(item),
    swatch: item.swatch || null,
    color: item.color || null,
    importance: importanceOf(item),
  };
}

const EVENT_SYSTEM = `You help a university student who also works part-time understand one specific calendar event they just tapped for more detail.

Return json with this exact shape:
{"summary":"...","action":"..."}

Rules:
- "summary": 2-4 plain sentences saying what this event actually is and why it's worth knowing about, grounded ONLY in the facts and notes given — never invent a detail that isn't there.
- "action": one short, concrete thing worth doing to prepare, or null if there's genuinely nothing to prepare (a routine meeting with no notes, for instance). Never invent a task the given notes don't support.
- No emoji, no generic filler ("Looking forward to it!").`;

function fmtEventPrompt(item, facts) {
  const lines = [`Title: ${item.title}`, `When: ${facts.when || "unspecified"}${facts.duration ? ` (${facts.duration})` : ""}`];
  if (facts.where) lines.push(`Location: ${facts.where}`);
  if (facts.attendees) lines.push(`Attendees: ${facts.attendees}`);
  if (facts.categoryLabel) lines.push(`Category: ${facts.categoryLabel}`);
  if (item.meta?.description) lines.push(`Notes: ${item.meta.description}`);
  return lines.join("\n");
}

const DEADLINE_SYSTEM = `You help a university student who also works part-time understand one specific deadline or task they just tapped for more detail.

Return json with this exact shape:
{"summary":"...","action":"..."}

Rules:
- "summary": 2-4 plain sentences explaining what this actually is and what's being asked, grounded ONLY in the facts/email text given — never invent a detail, a dollar amount, or a consequence that isn't stated.
- "action": one short, concrete next step to actually resolve this, or null if there's genuinely nothing left to do (e.g. it only needs reading, or it's already done). Never suggest an action the given text doesn't support.
- No emoji, no generic filler.`;

function fmtDeadlinePrompt(item, facts) {
  const lines = [`Title: ${item.title}`, `Due: ${facts.when || "no specific time"}`];
  if (facts.categoryLabel) lines.push(`Category: ${facts.categoryLabel}`);
  if (facts.from) lines.push(`From: ${facts.from}`);
  if (facts.status === "done") lines.push(`Status: already marked done`);
  if (item.meta?.body) lines.push(`Email body:\n${item.meta.body}`);
  else if (item.meta?.description) lines.push(`Notes: ${item.meta.description}`);
  else if (item.detail) lines.push(`Note: ${item.detail}`);
  return lines.join("\n");
}

const ALLDAY_SYSTEM = `You help a university student who also works part-time understand one specific all-day calendar item they just tapped for more detail.

Return json with this exact shape:
{"summary":"...","action":"..."}

Rules:
- "summary": 1-3 plain sentences saying what this actually is, grounded ONLY in the facts/notes given.
- "action": one short, concrete thing worth doing about it, or null if it's purely informational (a payday, a birthday) and there's nothing to do.
- No emoji, no generic filler.`;

function fmtAllDayPrompt(item, facts) {
  const lines = [`Title: ${item.title}`];
  if (facts.categoryLabel) lines.push(`Category: ${facts.categoryLabel}`);
  if (item.meta?.description) lines.push(`Notes: ${item.meta.description}`);
  else if (item.detail) lines.push(`Note: ${item.detail}`);
  return lines.join("\n");
}

const PROMPTS = {
  event: { system: EVENT_SYSTEM, fmt: fmtEventPrompt },
  deadline: { system: DEADLINE_SYSTEM, fmt: fmtDeadlinePrompt },
  allday: { system: ALLDAY_SYSTEM, fmt: fmtAllDayPrompt },
};

/**
 * One on-demand DeepSeek call for exactly one item, cached by (item id +
 * its own contentHash) so a second click — or the same item surviving
 * unchanged to a later click — never pays twice; only a real edit to the
 * item (a rescheduled time, a renamed title) changes the hash and earns a
 * fresh call. `hintKind`, when it's one of "event"/"deadline"/"allday",
 * overrides the server's own best guess (see inferKind() above) — the
 * frontend already knows which list the click came from, so trust it over
 * a guess whenever it's given.
 *
 * Returns `{ id, kind, facts, ai: {summary, action} | null }` — `facts` is
 * always present (pure data, no AI); `ai` is null only when the model is
 * off, unavailable, or returned something unparseable, so a click never
 * shows a blank panel, only a plainer one.
 */
export async function buildItemDetail(item, config, { tz, hintKind } = {}) {
  const timeZone = tz || config.timezone || "America/Toronto";
  const kind = KINDS.has(hintKind) ? hintKind : inferKind(item);
  const facts = buildFacts(item, timeZone);
  const { system, fmt } = PROMPTS[kind];

  const key = cacheKey("item-detail", { id: item.id, h: item.contentHash, k: kind });
  const parsed = await ask({
    system,
    user: fmt(item, facts),
    config,
    maxTokens: 260,
    json: true,
    cacheAs: key,
  });

  let ai = null;
  if (parsed && typeof parsed.summary === "string" && parsed.summary.trim()) {
    ai = {
      summary: parsed.summary.trim().slice(0, 700),
      action: typeof parsed.action === "string" && parsed.action.trim() ? parsed.action.trim().slice(0, 200) : null,
    };
  }

  return { id: item.id, kind, facts, ai };
}
