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

/**
 * Match a pattern as a WORD, not a substring.
 *
 * Plain `includes()` is a trap here: "exam" matches "example.com", "lab"
 * matches "collaborate", "due" matches "overdue". A calendar literally named
 * with your email address was being classified as a Test because the address
 * contained "example".
 *
 * A trailing plural is allowed, because config reads better in the singular
 * while calendars are usually named in the plural ("test" must still match
 * "Tests & Quizzes").
 */
function hasPhrase(haystack, phrase) {
  const p = String(phrase || "").toLowerCase().trim();
  if (!p) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}(s|es|'s)?([^a-z0-9]|$)`, "i")
    .test(String(haystack || "").toLowerCase());
}

function anyPattern(haystack, patterns) {
  return (patterns || []).some((p) => hasPhrase(haystack, p));
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
 * Which part of your life does this belong to?
 *
 * Deliberately a SEPARATE axis from category. "CANNOT MISS" tells you how
 * much something matters, not what kind of life it belongs to — a can't-miss
 * event could be a final exam or a friend's wedding. Category answers "what
 * kind of thing"; domain answers "which lane of my life", and the brief is
 * grouped by the second one.
 *
 * Resolution order: explicit patterns first, then a hint from the category,
 * then personal as the catch-all. Nothing here names your calendars.
 */
export function deriveDomain({ title = "", calendarName = "", body = "", category = null, path = "" }, config = {}) {
  const spec = config.domains || {};
  const defs = spec.definitions || [];
  const haystackTitle = `${title} ${body}`;

  for (const def of defs) {
    if (anyPattern(calendarName, def.calendarPatterns)) return def.id;
  }
  for (const def of defs) {
    if (anyPattern(haystackTitle, def.titlePatterns)) return def.id;
  }
  for (const def of defs) {
    if (path && anyPattern(path, def.pathPatterns)) return def.id;
  }

  // A course code is a strong school signal even with no keyword.
  if (looksLikeCourseCode(title) && defs.some((d) => d.id === "school")) return "school";

  const fromCategory = spec.fromCategory?.[category];
  if (fromCategory) return fromCategory;

  return spec.fallback || "personal";
}

export function domainLabel(id, config = {}) {
  const def = (config.domains?.definitions || []).find((d) => d.id === id);
  return def?.label || (id ? id[0].toUpperCase() + id.slice(1) : "Personal");
}

/**
 * Which colour a calendar event paints on the day strip.
 *
 * A third axis, separate from both category and domain: this one exists
 * purely to mirror what the calendars already look like in Apple Calendar,
 * so the strip reads at a glance the same way the calendar app does. It
 * rides on the category id (CANNOT MISS, IMPORTANT EVENTS, WORK, Tests &
 * Quizzes, School & Classes and Family all already have their own category,
 * matched off the real calendar name) with one override: the default
 * calendar — the one Google names after your email address because you
 * never gave it a real name — always paints the same light "link" blue,
 * regardless of what category its events land in.
 */
export function calendarSwatch({ calendarName = "", category = "personal" } = {}) {
  if (isEmailLike(calendarName)) return "gmail";
  return category || "personal";
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
