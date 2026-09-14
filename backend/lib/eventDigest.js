// lib/eventDigest.js
//
// Short, LED-wall-friendly one-line descriptions for today's TIMED calendar
// events (round 77 — Jon: "the description for the events... is wrapping
// onto a third line, which doesn't work because we don't have three lines
// since that is taken out by the timeline animation of the actual bar of
// progress... we don't need the location in the description necessarily,
// only important notes about the event... run it through DeepSeek... make
// sure it knows to do a very concise but clear LED wall minimal character
// description").
//
// Same shape as lib/newsDigest.js: one batched call (never one call per
// event — see ai.js's own header comment on that convention), cached by
// content hash so DeepSeek only runs again once today's actual event set
// (titles/details) changes, not on every 15-minute pull if nothing did.
//
// Degrades to a plain deterministic one-fact truncation on any failure
// (missing key, provider off, malformed response, nothing to summarize) —
// the wall must never wait on the model or show nothing because DeepSeek
// is down. shortDescFallback() below is that floor, and it's applied
// per-event regardless of whether the AI step ever ran at all, so a brand
// new event shows a safe short description immediately, before the next
// 15-minute digest refresh has even had a chance to see it.

import { ask } from "./ai.js";
import { cacheKey } from "./ids.js";
import { logger } from "./log.js";
import { allItems, getMeta, setMeta } from "./store.js";

const log = logger("eventDigest");

const SYSTEM = `You write ultra-short one-line descriptions for a tiny scrolling LED display, for a list of real calendar events.

Return json: {"descriptions":[{"id":"...","desc":"..."}, ...]}

Rules:
- One entry per event id given below, in the same order.
- Each event's "raw" field is a "·"-separated grab-bag of whatever facts we have on file for it — it may include a personal note, a duration, a location, and an attendee count, in no fixed order, and some of those pieces may be missing entirely.
- Keep only the single most useful fact for actually remembering what this event is about — almost always that means a real personal note if one exists. Only keep a location if the title alone genuinely wouldn't tell someone where to go. Drop duration and attendee count entirely unless nothing else is available.
- Aim for under 28 characters. Shorter is always better. Never pad with filler words.
- If there is genuinely nothing worth adding beyond the title, return "" for that event.
- Never invent a fact, a location, a name, or a number that isn't present in the input.`;

function fmtForPrompt(events) {
  return events.map((e) => `${e.id} | ${e.title}${e.raw ? ` | ${e.raw}` : ""}`).join("\n");
}

/**
 * `events` is today's timed calendar items shaped as {id, title, raw}
 * (raw = the item's existing joined `detail` string — note/duration/
 * location/attendees, whatever's on file; see sources/calendar.js). Returns
 * a plain {[id]: desc} map, never null — callers always do
 * `map[id] ?? shortDescFallback(item.detail)`.
 */
export async function getEventDigest(config, events, { previous = null } = {}) {
  const raw = (events || []).filter((e) => e?.id && e?.title);
  if (!raw.length) return {};

  const key = cacheKey("eventDigest-v1", { events: raw.map((e) => ({ id: e.id, title: e.title, raw: e.raw || "" })) });
  const parsed = await ask({
    system: SYSTEM,
    user: `Return json.\n\n${fmtForPrompt(raw)}`,
    config,
    maxTokens: 600,
    json: true,
    cacheAs: key,
  });

  const list = Array.isArray(parsed?.descriptions) ? parsed.descriptions : null;
  if (!list) return previous || {};

  const map = {};
  for (const d of list) {
    if (d && typeof d.id === "string" && typeof d.desc === "string") {
      map[d.id] = d.desc.trim().slice(0, 40);
    }
  }
  return Object.keys(map).length ? map : previous || {};
}

/**
 * Zero-AI floor, applied whenever an event has no cached digest entry yet
 * (brand new event, digest not refreshed since, or the model is off/down):
 * just the FIRST "·"-separated segment of the item's existing `detail`
 * string. sources/calendar.js builds that string today-relative as
 * [note, durationLabel, location, attendeeCount].filter(Boolean).join(" · "),
 * so the first segment is the personal note when one exists — otherwise
 * whatever's next — never the full multi-fact pileup. Same "drop the
 * location" intent as the AI path above, just without needing a model call.
 */
export function shortDescFallback(detail) {
  if (!detail) return "";
  return detail.split(" · ")[0].trim().slice(0, 40);
}

function todayKeyFor(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Called once per scheduler tick (see scheduler.js), right after
 * runSources() — NOT from the fast /api/matrix poll route, which must stay
 * a zero-external-call read of whatever this last wrote. Computes today's
 * digest from the store and caches it as its own meta blob, same pattern
 * as sources/marketNews.js's marketPulse.newsDigest.
 */
export async function refreshEventDigest(config) {
  const today = todayKeyFor(config.timezone);
  const items = await allItems();
  const todaysTimedEvents = items.filter(
    (i) => i.source === "calendar" && !i.meta?.allDay && i.dueAt?.startsWith(today) && i.status === "open"
  );
  const raw = todaysTimedEvents.map((e) => ({ id: e.id, title: e.title, raw: e.detail || "" }));

  const previousBlob = await getMeta("eventDigest", null);
  const previousMap = previousBlob?.day === today ? previousBlob.map : null;
  const map = await getEventDigest(config, raw, { previous: previousMap });
  await setMeta("eventDigest", { map, day: today, at: new Date().toISOString() });
  log.info(`refreshed for ${raw.length} event(s) today`);
}
