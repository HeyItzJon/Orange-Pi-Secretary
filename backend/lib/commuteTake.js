// lib/commuteTake.js
//
// One short, actionable line about today's driving day, for the Commute
// page's full-day plan. Round 92's brief (Jon, verbatim): "I would be
// inclined to pass all the travel times and destinations and routes if
// possible to deepseek and get it to suggest. things like. this is peak
// rush hour, consider staying on campus for an hour to avoid the worst of
// it. or expect delays if im leaving to go to school at like 8AM for rush
// hour. rush hour is a big deal to me. try and build a logical flow."
//
// Same split as every other AI feature here (see lib/ai.js's own header,
// and lib/weatherTake.js which this is modeled on): lib/commute.js's
// refreshCommute() has ALREADY decided every fact this reads — each leg's
// minutes/km/route/mode, and critically whether a leg falls in a rush-hour
// window (isRushHour(), a deterministic time-window check against
// config.commute.rushHours — never left for the AI to guess at from a
// timestamp). This file only turns those already-decided facts into one
// well-written, genuinely useful line. It never sees a raw Google Routes
// response or the calendar directly, and can't invent a duration, a
// destination, or a delay that isn't already a decided fact handed to it.
//
// Rush hour is the one thing Jon explicitly called out as important, so the
// prompt below makes it the top priority when it's real: if a leg is inside
// a configured rush window, say so plainly, and — only when the day's own
// events actually offer a realistic alternative (a gap before a later leg,
// a same-place buffer that could just be waited out) — suggest it
// concretely. On a light or rush-free day it falls back to something plain
// and still useful (the day's total drive time) rather than forcing an
// angle that isn't there.
//
// Cached by content hash (lib/ids.js's cacheKey) rather than a once-a-day
// gate — same reasoning lib/newsDigest.js and lib/weatherTake.js give: the
// facts change (a leg re-times, traffic re-estimates minutes, an event
// moves), the cache key changes with them, and a genuinely unchanged plan
// costs zero extra calls. Degrades to null on any failure (provider off,
// bad response, network error) — refreshCommute() already falls back to
// the previous plan's insight in that case, so a live commute plan is never
// blocked on this line.

import { ask } from "./ai.js";
import { cacheKey } from "./ids.js";
import { logger } from "./log.js";

const log = logger("commuteTake");

const SYSTEM = `You write one short, actionable line about today's driving commute for a personal dashboard. The reader already sees every leg's exact time, minutes, and route right next to this line — your only job is to add a genuinely useful suggestion or heads-up, grounded ONLY in the facts given below.

Return json: {"summary":"..."}

Rules:
- 1 sentence, under 160 characters.
- Only ever reference a leg, time, or number that is actually given below — never invent a duration, a destination, or a delay that isn't in the data.
- Prefer a DAY-LEVEL observation over a single-leg one when the data below actually supports one — these are pre-computed facts, never your own inference:
  - "Both rush hours hit" (bothRushHit: true) is worth naming on its own, and worth suggesting which ONE of the two to try alleviating (usually the one with a realistic gap/alternative visible in the legs) rather than treating them as unrelated.
  - "Heavy drive day" (heavyDriveDay: true) is worth naming plainly — e.g. total drive time is unusually high today.
  - Each entry in rushLegs carries the real rush window's start/end clock time and the real event you're driving to — use that to give a genuine boundary ("beats the 15:30 rush" / "don't delay past your 2:30 class" style), but ONLY when the event's own end time or the window boundary given actually supports that specific claim. Never invent a class time that isn't in the data.
- Outside those day-level facts, rush hour on a single leg is still the next most important thing to flag: if a leg's isRush is set, say so plainly and, if there's a genuine alternative visible in the data (e.g. a later leg to/from the same place that isn't rush hour, or enough of a gap to wait it out), suggest it concretely ("consider leaving after 9" / "staying on campus another hour avoids the worst of it") — but only suggest a delay that's actually realistic given the day's own events, never a vague "avoid rush hour" platitude.
- Morning rush gets accuracy, not a "leave earlier" suggestion — Jon: "for morning idk if leaving early is much help just make sure I have an accurate morning commute time." Only suggest shifting a departure for an EVENING/afternoon rush leg.
- If nothing today is genuinely notable (no rush-hour legs, a light day), it's fine to say something plain and useful instead — e.g. name the day's total drive time, or that the day is light on driving. Don't force a rush-hour angle that isn't there.
- No emoji, no exclamation points, no filler like "have a great day" or "drive safe."`;

function fmtForPrompt({ legs, totalDriveMinutes, totalKm, fuelCostCAD, rushLegCount, bothRushHit, heavyDriveDay, rushLegSummaries }) {
  const lines = [];
  if (!legs.length) {
    lines.push("No commute legs today.");
  } else {
    lines.push("Today's legs:");
    for (const l of legs) {
      const when = new Date(l.toStart).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
      // Drive legs are broken out as pure driving vs. the walk-to/from-the-
      // car buffers baked onto either end — Jon: "the walking doesnt count
      // for drive time... its just needed for timing." Kept visible here
      // (not folded away) since a walk buffer still shifts WHEN you need to
      // leave, which matters for a rush-hour suggestion.
      const walk = (l.departureBufferMin || 0) + (l.arrivalBufferMin || 0);
      lines.push(
        `- arriving ${l.toEventTitle || l.label} at ${when}: ${
          l.mode === "drive"
            ? `${l.driveMinutes}min drive${walk ? ` + ${walk}min walk` : ""} (route: ${l.route})`
            : `${l.minutes}min walk buffer, no drive`
        }${l.isRush ? ` [${l.isRush}]` : ""}`
      );
    }
  }
  lines.push(
    `Daily totals: ${totalDriveMinutes}min driving, ${totalKm}km driven${
      fuelCostCAD != null ? `, ~$${fuelCostCAD.toFixed(2)} in gas` : ""
    }.`
  );
  // Round 92 — the already-decided day-level facts (lib/commute.js's
  // refreshCommute) the SYSTEM prompt above tells the model to prefer over
  // a single-leg observation. Always printed, even when false/zero, so the
  // model can see "both rush hours" was actually checked and came back
  // false rather than just being absent from the data.
  lines.push(`Day facts: rushLegCount=${rushLegCount ?? 0}, bothRushHit=${!!bothRushHit}, heavyDriveDay=${!!heavyDriveDay}.`);
  if (rushLegSummaries?.length) {
    lines.push("rushLegs:");
    for (const r of rushLegSummaries) {
      const when = new Date(r.toStart).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
      lines.push(
        `- ${r.toEventTitle} at ${when}${r.window ? ` (inside ${r.window.label}, ${r.window.start}–${r.window.end})` : ""}`
      );
    }
  }
  return lines.join("\n");
}

// getCommuteInsight(config, plan, {previous}) -> {text, at} | {text: null, at: null | previous.at}
//
// plan is the full commutePlan blob refreshCommute() builds (legs[],
// totalDriveMinutes, totalKm, fuelCostCAD). previous is the prior commutePlan
// (same shape, or null) — used only so a failed/empty result can carry
// forward the previous insight's timestamp rather than lying about when it
// was last refreshed.
export async function getCommuteInsight(config, plan, { previous = null } = {}) {
  if (!plan.legs?.length) return { text: null, at: null };
  const key = cacheKey("commuteTake-v1", plan);
  const parsed = await ask({
    system: SYSTEM,
    user: `Return json.\n\n${fmtForPrompt(plan)}`,
    config,
    maxTokens: 120,
    json: true,
    cacheAs: key,
  });
  const text = typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 220) : null;
  if (!text) return { text: null, at: previous?.at || null };
  const at = new Date().toISOString();
  log.info(`refreshed: ${text}`);
  return { text, at };
}
