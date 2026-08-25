// brief/priorities.js
//
// The one place the model is allowed an opinion.
//
// Everywhere else in this system the rules decide and the model only writes
// things up. Here it does the thing rules are genuinely bad at: looking at a
// week of calendar and whatever the inbox coughed up, and saying "this is
// the one that matters, and here is the next physical action."
//
// Three guards keep it honest:
//
//   - It can only choose from ids it was given. Anything it invents is
//     dropped on the floor before it reaches the screen.
//   - It never sees the whole item, only a compact line. No email bodies, no
//     note contents, nothing from Journal or a `sensitive: true` note.
//   - It's cached on a hash of the input set, so a 15-minute pull cycle
//     doesn't mean 96 model calls a day. Nothing changed, nothing spent.
//
// If the model is off, keyless or down, `rankFallback` runs instead and the
// page still fills. It's dumber, not absent.

import { logger } from "../lib/log.js";
import { ask } from "../lib/ai.js";
import { cacheKey } from "../lib/ids.js";

const log = logger("priorities");

const SYSTEM = `You triage a personal work queue for a third-year electrical engineering student in Ottawa who also works part-time and is job-hunting for a co-op term.

You will be given candidate items, each starting with a bracketed tag, e.g. [calendar_caf11e9021de]. Return json:
{"priorities":[{"tag":"<the exact tag from the list, brackets included>","do":"<the next physical action, imperative, under 60 chars>","why":"<why it is worth doing now, under 90 chars>"}]}

Rules:
- Choose at most 6. Fewer is fine. Rank most important first.
- ONLY use tags copied exactly from the list. Never invent one, never alter one, never guess one from memory — copy the bracketed text as it appears on that item's own line.
- "do" and "why" must describe THAT SAME tagged item and nothing else. Do not pull an action or reason from a different line, even if it seems related.
- "do" is a concrete next action someone could start in the next ten minutes — "Email the TA about the lab swap", not "Handle school stuff". If the item already names its action, sharpen it, don't restate it.
- "why" gives the reason it is live NOW: a date pressing, something blocking something else, something rotting. Never restate the title.
- Do not invent an action the item's own line does not support. Something merely mentioning a policy, a fee, or a general note — for information, not a request — is not a reason to invent an action like "cancel" or "pay"; if nothing concrete is actually being asked of the person, leave it out of your picks rather than manufacture urgency.
- Prefer: things with a real deadline; things blocking other work; things that decay if ignored (applications, replies people are waiting on); things untouched longest.
- Deprioritise: nice-to-haves, ideas, anything with no consequence for being late.
- Plain language. No motivational filler, no emoji, no exclamation marks.`;

/**
 * A compact one-liner per candidate. Small on purpose — this is what gets
 * hashed for the cache and what the model actually reads.
 *
 * Leads with a short id tag rather than a position number. The model used to
 * be asked to echo back a number ("use item 7's action"), and on real data it
 * sometimes miscounted — the "do"/"why" text for one item would land on a
 * completely different item at render time, because a number is disconnected
 * from the thing it points at. A tag copied verbatim off the item's own line
 * has no such failure mode: either it matches an id we handed out, or it's
 * dropped.
 */
function line(it, i, now) {
  const bits = [`[${it.id}] ${it.title}`];
  if (it.dueAt) {
    const days = Math.round((new Date(it.dueAt) - now) / 86400000);
    bits.push(days <= 0 ? "(due today)" : days === 1 ? "(due tomorrow)" : `(due in ${days}d)`);
  }
  if (it.meta?.age >= 7) bits.push(`(untouched ${it.meta.age}d)`);
  if (it.meta?.note) bits.push(`[${it.meta.note}]`);
  else if (it.source === "email") bits.push("[email]");
  else if (it.source === "calendar") bits.push("[calendar]");
  if (it.unmissable) bits.push("(can't miss)");
  return bits.join(" ");
}

/**
 * Deterministic ranking, used when the model is unavailable and as the
 * ordering the model's picks are laid over.
 */
export function rankFallback(items, now = new Date()) {
  return [...items]
    .map((it) => {
      let score = it.categoryWeight || 10;
      if (it.dueAt) {
        const days = (new Date(it.dueAt) - now) / 86400000;
        score += days <= 0 ? 60 : days <= 1 ? 50 : days <= 3 ? 36 : days <= 7 ? 22 : 8;
      }
      if (it.unmissable) score += 30;
      if (it.emphasised) score += 18;
      if (it.meta?.needsReply) score += 16;
      score += Math.min(14, Math.floor((it.meta?.age || 0) / 5));
      return { it, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it);
}

/**
 * Anything open and actionable enough for "Start here". Calendar entries
 * that are just "be in this room at this time" are excluded — they're on
 * the timeline, and putting "attend ELEC 3105" on a to-do list is noise.
 *
 * Undated items only get a couple of days here before they age out on their
 * own — a stale-looking list was exactly the complaint. A dated item is
 * unaffected: its own due date already decides when it stops mattering, and
 * marking something done or dismissed removes it outright regardless of
 * age, via the status check below.
 */
export function filterCandidates(items, now = new Date(), config = {}) {
  const undatedMaxAgeDays = config.display?.undatedMaxAgeDays ?? 2;
  return items.filter((it) => {
    if (it.status && it.status !== "open") return false;
    if (it.kind === "system") return false;
    if (it.source === "calendar" && !it.dueAt) return false;
    if (it.source === "calendar" && !it.unmissable && !it.emphasised && !it.meta?.needsPrep) return false;
    if (!it.dueAt) {
      const seenAt = new Date(it.firstSeen || it.lastSeen || now).getTime();
      const ageDays = (now - seenAt) / 86400000;
      if (ageDays > undatedMaxAgeDays) return false;
    }
    return true;
  });
}

/**
 * @returns {Promise<{list: Array, source: "model"|"rules", at: string}>}
 */
export async function buildPriorities(items, { config, now = new Date(), limit = 6 } = {}) {
  const candidates = filterCandidates(items, now, config);
  if (!candidates.length) return { list: [], source: "rules", at: now.toISOString() };

  const ordered = rankFallback(candidates, now).slice(0, 28);
  const lines = ordered.map((it, i) => line(it, i, now));

  const fallback = () => ({
    list: ordered.slice(0, limit).map((it) => ({
      id: it.id,
      title: it.title,
      do: null,
      why: it.reasons?.[0] || null,
      domain: it.domain,
      source: it.source,
      dueAt: it.dueAt || null,
      note: it.meta?.note || null,
    })),
    source: "rules",
    at: now.toISOString(),
  });

  const res = await ask({
    system: SYSTEM,
    user: `Today is ${now.toDateString()}. Return json.\n\n${lines.join("\n")}`,
    config,
    maxTokens: 700,
    json: true,
    // Hash the candidate set, not the clock: same work in, same answer out,
    // no second call. Changing what's open is what makes this re-run.
    // (v2: tag-based selection, replacing the numeric-index scheme below.)
    cacheAs: cacheKey("priorities-v2", { lines }),
  });

  const picks = Array.isArray(res?.priorities) ? res.priorities : null;
  if (!picks?.length) {
    log.info("no model priorities — using rules");
    return fallback();
  }

  const list = matchPicksToItems(picks, ordered, limit);
  if (!list.length) return fallback();
  log.info(`${list.length} priorities from model (${candidates.length} candidates)`);
  return { list, source: "model", at: now.toISOString() };
}

/**
 * Turn the model's raw picks into display-ready priority rows, matched by
 * the literal id tag it echoed back rather than by counting to a number —
 * see the comment on line() for why a number was the wrong call. Pure and
 * exported so this, the part that was actually wrong on real data, can be
 * tested without touching the network or the store.
 *
 * A tag that isn't in `ordered`, is malformed, or repeats an id already
 * used is dropped rather than guessed at.
 */
export function matchPicksToItems(picks, ordered, limit = 6) {
  const byId = new Map(ordered.map((it) => [it.id, it]));
  const seen = new Set();
  const list = [];
  for (const p of picks) {
    const tag = typeof p?.tag === "string" ? p.tag.trim().replace(/^\[|\]$/g, "") : "";
    const it = byId.get(tag);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    list.push({
      id: it.id,
      title: it.title,
      do: typeof p?.do === "string" ? p.do.trim().slice(0, 80) : null,
      why: typeof p?.why === "string" ? p.why.trim().slice(0, 110) : null,
      domain: it.domain,
      source: it.source,
      dueAt: it.dueAt || null,
      note: it.meta?.note || null,
    });
    if (list.length >= limit) break;
  }
  return list;
}
