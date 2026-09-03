// brief/ask.js
//
// Backs the chat panel (round 55 follow-up — Jon: "a helper chat that has
// access to all the site information," to ask about his schedule, tasks,
// and portfolio in plain language). Same division of labour as everywhere
// else in this codebase: this file assembles the actual facts (pure,
// tested), and lib/ai.js's ask() just writes up an answer from them — it
// never gets to decide what's true, only how to phrase it. That's also why
// buildAskContext() below doesn't just reuse buildDisplay()'s output
// wholesale: that object is shaped for rendering seven UI pages (badges,
// day-strip pixel blocks, the 365-cell year grid) and dumping all of it
// into a prompt would bury the model in irrelevant layout data instead of
// the facts it actually needs to answer a question.
//
// No tool-calling / agent loop here on purpose — see
// round-49-jarvis-voice-esp-roadmap.md's verdict on that: prove out plain
// ask-and-answer first. This always gathers the same bounded, cheap set of
// current facts (today/this-week events, open tasks, the portfolio) up
// front, in one shot, rather than letting the model decide what to fetch.

import { isTaskLike } from "./display.js";
import { calendarDaysBetween } from "../lib/time.js";

const UPCOMING_EVENT_HORIZON_DAYS = 10;
const MAX_TASKS = 40;

/**
 * Pure. Given the same raw inputs collect()/compose.js already gathers
 * every cycle (not buildDisplay()'s rendered output — see file header),
 * produces a compact, plain-language-friendly snapshot of what's
 * actually true right now: open tasks, the next ~10 days of calendar
 * events, and the portfolio. Anything with status other than "open" (or
 * no status at all yet) is left out — a dismissed or resolved item isn't
 * a current fact worth grounding an answer in.
 */
export function buildAskContext({ items = [], money = null, marketPulse = null, now = new Date(), config = {} } = {}) {
  const tz = config.timezone || "America/Toronto";
  const open = items.filter((i) => i.status == null || i.status === "open");
  const daysAway = (dueAt) => (dueAt ? calendarDaysBetween(now.toISOString(), dueAt, tz) : null);

  const upcomingEvents = open
    .filter((i) => i.source === "calendar" && i.dueAt)
    .map((i) => ({ ...i, daysAway: daysAway(i.dueAt) }))
    .filter((i) => i.daysAway != null && i.daysAway >= 0 && i.daysAway <= UPCOMING_EVENT_HORIZON_DAYS)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .map((i) => ({
      title: i.title,
      when: i.dueAt,
      daysAway: i.daysAway,
      allDay: Boolean(i.meta?.allDay),
      location: i.meta?.location || null,
      calendar: i.meta?.calendarName || null,
    }));

  const tasks = open
    .filter(isTaskLike)
    .map((i) => ({ ...i, daysAway: daysAway(i.dueAt) }))
    .sort((a, b) => (a.daysAway ?? 9999) - (b.daysAway ?? 9999))
    .slice(0, MAX_TASKS)
    .map((i) => ({
      title: i.title,
      source: i.source,
      dueAt: i.dueAt || null,
      daysAway: i.daysAway,
      detail: i.detail || null,
    }));

  const positions = (money?.positions || [])
    .slice()
    .sort((a, b) => Math.abs(b.dayChangePct ?? 0) - Math.abs(a.dayChangePct ?? 0))
    .map((p) => ({
      ticker: p.ticker,
      name: p.name || null,
      price: p.price ?? null,
      dayChangePct: p.dayChangePct ?? null,
      weightPct: p.weightPct ?? null,
      currency: p.currency || null,
      stale: Boolean(p.stale),
      unavailable: Boolean(p.unavailable),
    }));

  return {
    now: now.toISOString(),
    portfolio: money && {
      asOf: money.at,
      base: money.base,
      total: money.total,
      dayChangePct: money.dayPct,
      dayChangeValue: money.dayChangeValue,
      weekChangePct: money.weekPct,
      monthChangePct: money.monthPct,
      marketStatus: money.marketStatus,
      holdingCount: money.holdingCount,
      positions,
    },
    marketIndices: (marketPulse?.indices || []).map((i) => ({ label: i.label, pct: i.pct })),
    upcomingEvents,
    tasks,
  };
}

const SYSTEM_PROMPT = `You are the chat helper built into Jon's personal dashboard (pi-secretary). You answer questions about his schedule, tasks, and portfolio.

Rules:
- Answer ONLY using the JSON data provided below. It is the complete, current picture — there is nothing else to check.
- If the data doesn't contain what's being asked, say so plainly rather than guessing or inventing a figure, date, or holding.
- Be concise and direct — a sentence or two for most questions, not a report. This is a chat, not a brief.
- Dollar figures use the portfolio's own "base" currency unless a position says otherwise.
- Never give financial advice (buy/sell/hold recommendations) — you can state facts about the portfolio, not recommend action on it. If asked for advice, say that's not something you'll weigh in on and stick to the facts.`;

/**
 * Pure. Builds the {system, user} pair passed to lib/ai.js's ask(). Kept
 * separate from the network call itself so the actual prompt shape is
 * unit-testable without hitting a real API.
 *
 * `history` is a small array of prior {role, content} turns from THIS chat
 * session — sent back by the frontend each time (see /api/ask in
 * server.js), not stored server-side. Folded into the user message as a
 * plain transcript rather than a real multi-turn `messages` array, since
 * lib/ai.js's ask() only ever sends one system + one user message —
 * changing that shared function's interface for one caller wasn't worth
 * it for a personal chat panel like this.
 */
export function buildAskPrompt({ context, question, history = [] }) {
  const transcript = history
    .slice(-10)
    .map((turn) => `${turn.role === "assistant" ? "You" : "Jon"}: ${turn.content}`)
    .join("\n");

  const user = [
    `Current data (JSON):\n${JSON.stringify(context)}`,
    transcript ? `Conversation so far:\n${transcript}` : null,
    `New question from Jon: ${question}`,
  ].filter(Boolean).join("\n\n");

  return { system: SYSTEM_PROMPT, user };
}
