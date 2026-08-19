// classify.js
//
// What kind of thing is this, and how loudly should it rank?
//
// Two principles:
//
//   1. NOTHING HERE KNOWS YOUR SPECIFIC CALENDARS OR PEOPLE. Categories are
//      derived from patterns declared in config.json. Rename a calendar,
//      change jobs, add a course — you edit config, never this file.
//
//   2. Your own conventions are signals. You put things in ALL CAPS when they
//      matter, so caps are read as emphasis. Course codes look like "MSE 3401",
//      so that shape means "class". The system reads how you already work
//      instead of asking you to adopt its vocabulary.
//
// Everything is a pure function. No network, no clock, no state.

const DAY = 86400000;

/**
 * You type in caps when something matters. Detect that without firing on
 * ordinary acronyms: "MSE 3401 lecture" is 30% uppercase, "PHYSIO" is 100%.
 */
export function isEmphasised(text) {
  const letters = String(text || "").replace(/[^a-zA-Z]/g, "");
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.7;
}

/** "MSE 3401", "PHYS1010", "CEG 4136A" — the shape of a course code. */
export function looksLikeCourseCode(text) {
  return /\b[A-Z]{2,4}\s?\d{3,4}[A-Z]?\b/.test(String(text || ""));
}

/** An email address used as a calendar name is Google's default, not a label. */
export function isEmailLike(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text || "").trim());
}

function anyPattern(haystack, patterns) {
  const h = String(haystack || "").toLowerCase();
  return (patterns || []).some((p) => h.includes(String(p).toLowerCase()));
}

/**
 * Derive a category from config-declared patterns.
 *
 * Every definition that matches is collected and the heaviest one wins, so
 * an exam on the "School & Classes" calendar is still an assessment.
 */
export function categorise({ title = "", calendarName = "", body = "", tier = null }, config = {}) {
  const defs = config.categories?.definitions || [];
  const matches = [];

  for (const def of defs) {
    let hit = null;
    if (tier && def.tiers?.includes(tier)) hit = `tier ${tier}`;
    else if (anyPattern(calendarName, def.calendarPatterns)) hit = `calendar "${calendarName}"`;
    else if (anyPattern(title, def.titlePatterns)) hit = "title";
    else if (body && anyPattern(body, def.titlePatterns)) hit = "content";
    if (hit) matches.push({ def, why: hit });
  }

  // Structural signal: a course code means class, even with no keyword hit.
  if (!matches.length && looksLikeCourseCode(title)) {
    const classDef = defs.find((d) => d.id === "class");
    if (classDef) matches.push({ def: classDef, why: "course code" });
  }

  if (!matches.length) {
    const fallback = defs.find((d) => d.id === "personal") || {
      id: "personal", label: "Personal", weight: 24,
    };
    return { id: fallback.id, label: fallback.label, weight: fallback.weight, why: "no rule matched" };
  }

  matches.sort((a, b) => (b.def.weight || 0) - (a.def.weight || 0));
  const { def, why } = matches[0];
  return { id: def.id, label: def.label, weight: def.weight || 24, why, unmissable: Boolean(def.unmissable) };
}

/**
 * How close is it, expressed as a steep curve rather than a straight line.
 *
 * Deadlines don't feel linear: three days out is a lot more than twice as
 * pressing as six. The curve is deliberately flat past a week so a distant
 * exam can't outrank tomorrow's reply.
 */
export function urgencyBoost(daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return 0;
  if (daysUntil < 0) return 40;      // overdue
  if (daysUntil < 1) return 38;      // today
  if (daysUntil < 2) return 32;      // tomorrow
  if (daysUntil < 3) return 26;
  if (daysUntil < 4) return 20;
  if (daysUntil < 6) return 13;
  if (daysUntil < 8) return 8;
  if (daysUntil < 11) return 4;
  return 1;
}

/**
 * One transparent number, with its own receipt.
 *
 * v1 sorted by a flat "priority" field that mixed importance and urgency
 * together, so ties were common and nothing explained itself. Here each
 * component is separate and `why` records what contributed — which is what
 * makes the ordering debuggable when it looks wrong.
 */
export function rankItem(item, { now = new Date(), config = {} } = {}) {
  const cfg = config.ranking || {};
  const days = item.dueAt ? (new Date(item.dueAt).getTime() - now.getTime()) / DAY : null;

  const why = [];
  let score = 0;

  const categoryWeight = item.categoryWeight ?? 24;
  score += categoryWeight;
  why.push(`${item.categoryLabel || item.category || "uncategorised"} +${categoryWeight}`);

  const urg = urgencyBoost(days);
  if (urg) {
    score += urg;
    const when = days < 0 ? "overdue" : days < 1 ? "today" : `${Math.round(days)}d out`;
    why.push(`${when} +${urg}`);
  }

  if (item.meta?.needsReply) {
    const b = cfg.needsReplyBoost ?? 12;
    score += b;
    why.push(`needs a reply +${b}`);
  }

  if (item.kind === "conflict") {
    const b = cfg.conflictBoost ?? 14;
    score += b;
    why.push(`overlapping events +${b}`);
  }

  // Your caps convention, honoured.
  if (item.emphasised) {
    const b = cfg.emphasisBoost ?? 15;
    score += b;
    why.push(`you capitalised it +${b}`);
  }

  if (item.unmissable) {
    const b = cfg.unmissableBoost ?? 10;
    score += b;
    why.push(`can't-miss category +${b}`);
  }

  if (item.changed) {
    const b = cfg.changedBoost ?? 6;
    score += b;
    why.push(`changed +${b}`);
  }

  // Say the same thing too often and it earns a quieter place — but only
  // when nothing is close. Deadlines are exempt (see rules.suppress).
  const count = item.surfaceCount || 0;
  if (count > 2 && (days === null || days > 7)) {
    const p = Math.min(cfg.maxFatiguePenalty ?? 8, (count - 2) * 2);
    score -= p;
    why.push(`told you ${count}× -${p}`);
  }

  return { score: Math.round(score), why };
}

/**
 * "1h 30m", "50 min", "all day" — duration is the one thing about an event
 * you can't read off the title, so it's worth the space.
 */
export function durationLabel(start, end, allDay) {
  if (allDay) return "all day";
  if (!start || !end) return null;
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (mins <= 0 || mins > 60 * 24) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
