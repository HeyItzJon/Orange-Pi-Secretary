// scripts/test-rules.js
//
// Tests for the parts that decide what you see. All pure, so they run without
// touching Gmail, the model, or the system clock.
//
//   node scripts/test-rules.js

import assert from "node:assert/strict";
import { selectForBrief, urgency, isQuiet, isNew, SCHEMA } from "../brief/rules.js";
import { triage, isDistinctive, buildBoostQueries } from "../sources/email.js";
import { usefulNote, fullDescription } from "../sources/calendar.js";
import {
  categorise, deriveDomain, isEmphasised, looksLikeCourseCode, isEmailLike,
  calendarSwatch, urgencyBoost, rankItem, durationLabel,
} from "../lib/classify.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf-8"));

const NOW = new Date("2026-08-19T07:00:00-04:00");
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}
function group(name) { console.log(`\n${name}\n`); }

const base = {
  source: "email", kind: "fyi", title: "x", detail: "", url: null,
  dueAt: null, categoryWeight: 24, category: "personal", categoryLabel: "Personal",
  unmissable: false, emphasised: false, tier: "school", contentHash: "h",
  firstSeen: "2026-08-01T00:00:00Z", lastSeen: NOW.toISOString(),
  status: "open", surfaceCount: 0, lastSurfaced: null, snoozeUntil: null,
  changed: false, meta: {},
};
const item = (over) => ({ ...base, ...over, id: over.id || `i${Math.random()}` });
const rank = (over) => rankItem(item(over), { now: NOW, config }).score;

// ====================================================================
group("your own conventions");

test("ALL CAPS is read as emphasis", () => {
  assert.equal(isEmphasised("DENTIST APPOINTMENT"), true);
  assert.equal(isEmphasised("PHYSIO"), true);
});

test("but a normal title with an acronym is not", () => {
  assert.equal(isEmphasised("MSE 3401 lecture"), false);
  assert.equal(isEmphasised("UAV Design Team meeting"), false);
  assert.equal(isEmphasised("Coffee with Sam"), false);
});

test("short strings never count as emphasis", () => {
  assert.equal(isEmphasised("GYM"), false);
  assert.equal(isEmphasised("A"), false);
});

test("course codes are recognised by shape, not by a list", () => {
  assert.equal(looksLikeCourseCode("MSE 3401 lecture"), true);
  assert.equal(looksLikeCourseCode("PHYS1010 lab"), true);
  assert.equal(looksLikeCourseCode("CEG 4136A tutorial"), true);
  assert.equal(looksLikeCourseCode("Coffee with Sam"), false);
});

test("an email address used as a calendar name is detected", () => {
  assert.equal(isEmailLike("you@example.com"), true);
  assert.equal(isEmailLike("CANNOT MISS"), false);
});

// ====================================================================
group("categories");

test("the can't-miss calendar wins outright", () => {
  const c = categorise({ title: "Flight", calendarName: "CANNOT MISS" }, config);
  assert.equal(c.id, "critical");
  assert.equal(c.unmissable, true);
});

test("an exam on the school calendar is still a Test, not a Class", () => {
  const c = categorise({ title: "MSE 3401 midterm", calendarName: "School & Classes" }, config);
  assert.equal(c.id, "assessment");
});

test("an ordinary lecture on that calendar is a Class", () => {
  const c = categorise({ title: "MSE 3401 lecture", calendarName: "School & Classes" }, config);
  assert.equal(c.id, "class");
});

test("a course code alone is enough to mean Class", () => {
  const c = categorise({ title: "MSE 3401", calendarName: "you@example.com" }, config);
  assert.equal(c.id, "class");
});

test("the work calendar means Work", () => {
  assert.equal(categorise({ title: "Shift", calendarName: "WORK" }, config).id, "work");
});

test("Physio on the personal calendar is an Appointment, not 'your email address'", () => {
  const c = categorise({ title: "Physio", calendarName: "you@example.com" }, config);
  assert.equal(c.id, "appointment");
  assert.equal(c.label, "Appointment");
});

test("an email's rule tier carries into its category", () => {
  assert.equal(categorise({ title: "Chat", tier: "opportunity" }, config).id, "opportunity");
  assert.equal(categorise({ title: "Rota", tier: "work" }, config).id, "work");
});

test("anything unmatched falls back to Personal, never to nothing", () => {
  const c = categorise({ title: "Sam's birthday", calendarName: "you@example.com" }, config);
  assert.equal(c.id, "personal");
});

// ====================================================================
group("domains — which lane of your life");

const dom = (o) => deriveDomain(o, config);

test("the school calendar routes to School", () => {
  assert.equal(dom({ title: "MSE 3401 lecture", calendarName: "School & Classes" }), "school");
  assert.equal(dom({ title: "Midterm", calendarName: "Tests & Quizzes" }), "school");
});

test("the work calendar routes to Work", () => {
  assert.equal(dom({ title: "Shift", calendarName: "WORK" }), "work");
});

test("a barbecue is Social even with no social calendar", () => {
  assert.equal(dom({ title: "End of summer BBQ", calendarName: "you@example.com" }), "social");
  assert.equal(dom({ title: "Sam's birthday dinner", calendarName: "you@example.com" }), "social");
});

test("Physio is Personal", () => {
  assert.equal(dom({ title: "PHYSIO", calendarName: "you@example.com", category: "appointment" }), "personal");
});

test("an interview is Career, not Work", () => {
  assert.equal(dom({ title: "Interview with Nokia", category: "opportunity" }), "career");
});

test("IMPORTANCE never decides a lane — a can't-miss wedding is Social", () => {
  assert.equal(dom({ title: "Sarah's wedding", calendarName: "CANNOT MISS", category: "critical" }), "social");
});

test("...and a can't-miss exam is School", () => {
  assert.equal(dom({ title: "MSE 3401 final exam", calendarName: "CANNOT MISS", category: "critical" }), "school");
});

test("a vault note is filed by the folder you put it in", () => {
  assert.equal(dom({ title: "Look into CCO", path: "Areas/Finances/Investments/Uranium.md", category: "note" }), "finance");
  assert.equal(dom({ title: "Fix the airframe", path: "Areas/Projects/UAV.md", category: "note" }), "projects");
});

test("a course code alone routes to School", () => {
  assert.equal(dom({ title: "CEG 4136A", calendarName: "you@example.com" }), "school");
});

test("anything unrecognised lands in Personal, never nowhere", () => {
  assert.equal(dom({ title: "Pick up parcel", calendarName: "you@example.com" }), "personal");
});

test("patterns match whole words, not substrings", () => {
  // The bug this guards: "exam" matched "example.com", so a calendar named
  // with your own email address classified everything on it as a Test.
  assert.equal(dom({ title: "Coffee", calendarName: "you@example.com" }), "personal");
  assert.equal(categorise({ title: "Coffee", calendarName: "you@example.com" }, config).id, "personal");
  // "lab" must not fire on "collaborate", "due" must not fire on "overdue"
  assert.equal(categorise({ title: "Collaborate on the report" }, config).id, "personal");
});

test("...but a trailing plural still matches", () => {
  // config reads better singular; calendars are usually named plural
  assert.equal(categorise({ title: "Anything", calendarName: "Tests & Quizzes" }, config).id, "assessment");
  assert.equal(categorise({ title: "Anything", calendarName: "School & Classes" }, config).id, "class");
});

// ====================================================================
group("calendarSwatch — the day-strip colour mirrors Apple Calendar");

test("a category with its own real calendar paints as that category", () => {
  assert.equal(calendarSwatch({ calendarName: "CANNOT MISS", category: "critical" }), "critical");
  assert.equal(calendarSwatch({ calendarName: "WORK", category: "work" }), "work");
  assert.equal(calendarSwatch({ calendarName: "School & Classes", category: "class" }), "class");
});

test("the default, email-named calendar always paints gmail-blue — whatever its category", () => {
  assert.equal(calendarSwatch({ calendarName: "you@example.com", category: "personal" }), "gmail");
  // Even something that would otherwise read as a real category, like a
  // course code on the default calendar, still gets the override — the
  // calendar it's actually sitting on matters more than what it's about.
  assert.equal(calendarSwatch({ calendarName: "jon.m.bourget@gmail.com", category: "class" }), "gmail");
});

test("a real (non-email) calendar name is never mistaken for the default", () => {
  assert.equal(calendarSwatch({ calendarName: "Sydney's Demands", category: "family" }), "family");
  assert.equal(calendarSwatch({ calendarName: "Gym Schedule", category: "personal" }), "personal");
});

test("no calendar name at all still falls back to the category, not gmail", () => {
  assert.equal(calendarSwatch({ category: "opportunity" }), "opportunity");
  assert.equal(calendarSwatch({}), "personal");
});

// ====================================================================
group("ranking");

test("the urgency curve is steep near term and flat far out", () => {
  assert.ok(urgencyBoost(0) > urgencyBoost(2));
  assert.ok(urgencyBoost(2) > urgencyBoost(5));
  assert.ok(urgencyBoost(5) > urgencyBoost(12));
  assert.ok(urgencyBoost(-1) >= urgencyBoost(0), "overdue ranks at least as high as today");
  assert.equal(urgencyBoost(null), 0);
});

test("a test in 2 days outranks an opportunity in 12", () => {
  const exam = rank({ categoryWeight: 44, unmissable: true, dueAt: inDays(2) });
  const job = rank({ categoryWeight: 48, dueAt: inDays(12) });
  assert.ok(exam > job, `exam ${exam} should beat opportunity ${job}`);
});

test("but the same opportunity wins once it's the closer one", () => {
  const exam = rank({ categoryWeight: 44, unmissable: true, dueAt: inDays(12) });
  const job = rank({ categoryWeight: 48, dueAt: inDays(1) });
  assert.ok(job > exam, `opportunity ${job} should beat exam ${exam}`);
});

test("something you wrote in CAPS outranks a routine class at the same hour", () => {
  const caps = rank({ categoryWeight: 24, emphasised: true, dueAt: inDays(0.3) });
  const cls = rank({ categoryWeight: 34, dueAt: inDays(0.3) });
  assert.ok(caps > cls, `caps ${caps} should beat class ${cls}`);
});

test("an email needing a reply outranks a drifting holding", () => {
  const mail = rank({ categoryWeight: 40, meta: { needsReply: true } });
  const drift = rank({ categoryWeight: 24 });
  assert.ok(mail > drift);
});

test("repetition costs rank, but only when nothing is close", () => {
  const fresh = rank({ categoryWeight: 40, surfaceCount: 0 });
  const stale = rank({ categoryWeight: 40, surfaceCount: 8 });
  assert.ok(stale < fresh, "an over-told item should sink");

  const urgentFresh = rank({ categoryWeight: 40, surfaceCount: 0, dueAt: inDays(1) });
  const urgentStale = rank({ categoryWeight: 40, surfaceCount: 8, dueAt: inDays(1) });
  assert.equal(urgentStale, urgentFresh, "a near deadline is exempt from fatigue");
});

test("every score comes with a receipt", () => {
  const r = rankItem(item({ categoryWeight: 44, emphasised: true, dueAt: inDays(1) }), { now: NOW, config });
  assert.ok(r.why.length >= 3, "should explain category, urgency and emphasis");
  assert.ok(r.why.some((w) => w.includes("capitalised")));
});

// ====================================================================
group("event descriptions");

test("HTML is stripped and the first human line is kept", () => {
  assert.equal(usefulNote("<p>Bring your lab notebook</p><br>"), "Bring your lab notebook");
});

test("meeting boilerplate is skipped in favour of the real note", () => {
  const desc = "https://meet.google.com/abc-defg\n---\nJoin by phone\nBring the revised airframe drawings";
  assert.equal(usefulNote(desc), "Bring the revised airframe drawings");
});

test("an empty or boilerplate-only description yields nothing", () => {
  assert.equal(usefulNote(""), null);
  assert.equal(usefulNote("<br><br>"), null);
  assert.equal(usefulNote("https://zoom.us/j/123"), null);
});

test("long notes are truncated, not dumped", () => {
  const note = usefulNote("x".repeat(300));
  assert.ok(note.length <= 96, `got ${note.length}`);
  assert.ok(note.endsWith("…"));
});

// ====================================================================
group("fullDescription — every real line, not just the first (brief/detail.js's prompt input)");

test("keeps every human line, not just usefulNote's first one", () => {
  const desc = "https://meet.google.com/abc-defg\n---\nBring the revised airframe drawings\nAlso loop in the TA beforehand";
  assert.equal(fullDescription(desc), "Bring the revised airframe drawings Also loop in the TA beforehand");
});

test("still strips HTML and boilerplate the same way usefulNote does", () => {
  assert.equal(fullDescription("<p>Bring your lab notebook</p><br>"), "Bring your lab notebook");
});

test("an empty or boilerplate-only description yields null, same as usefulNote", () => {
  assert.equal(fullDescription(""), null);
  assert.equal(fullDescription("<br><br>"), null);
  assert.equal(fullDescription("https://zoom.us/j/123"), null);
});

test("truncates at a much higher cap than usefulNote's 96 chars, since this isn't squeezed into a row", () => {
  const long = fullDescription("word ".repeat(400));
  assert.ok(long.length <= 1200, `got ${long.length}`);
  assert.ok(long.endsWith("…"));
});

test("durations read the way a person would say them", () => {
  const s = "2026-08-19T09:30:00Z";
  assert.equal(durationLabel(s, "2026-08-19T10:20:00Z"), "50 min");
  assert.equal(durationLabel(s, "2026-08-19T11:30:00Z"), "2h");
  assert.equal(durationLabel(s, "2026-08-19T11:00:00Z"), "1h 30m");
  assert.equal(durationLabel(s, s, true), "all day");
});

// ====================================================================
group("clock, memory, sections");

test("urgency escalates as the date approaches", () => {
  assert.equal(urgency(item({ dueAt: inDays(10) }), NOW), null);
  assert.equal(urgency(item({ dueAt: inDays(5) }), NOW), "warning");
  assert.equal(urgency(item({ dueAt: inDays(2) }), NOW), "serious");
  assert.equal(urgency(item({ dueAt: inDays(0.5) }), NOW), "critical");
  assert.equal(urgency(item({ dueAt: inDays(-1) }), NOW), "critical");
});

test("an unchanged, undated item is marked quiet after maxRepeats", () => {
  assert.equal(isQuiet(item({ surfaceCount: 6 }), null, { maxRepeats: 6 }), true);
});

test("a deadline keeps its voice however often it has been said", () => {
  assert.equal(isQuiet(item({ surfaceCount: 99, dueAt: inDays(2) }), "serious", { maxRepeats: 6 }), false);
});

test("something you capitalised is never silenced", () => {
  assert.equal(isQuiet(item({ surfaceCount: 99, emphasised: true }), null, { maxRepeats: 6 }), false);
});

test("a changed item is never suppressed", () => {
  assert.equal(isQuiet(item({ surfaceCount: 99, changed: true }), null, {}), false);
});

test("on the very first brief nothing is 'new' — the backlog is baseline", () => {
  assert.equal(isNew(item({ surfaceCount: 0 }), null), false);
});

test("an item first seen after the last brief is new", () => {
  assert.equal(isNew(item({ firstSeen: "2026-08-19T06:00:00Z" }), "2026-08-18T06:40:00Z"), true);
});

test("today owns today; the lanes own everything else", () => {
  const old = "2026-08-01T00:00:00Z";
  const items = [
    item({ id: "a", kind: "today", source: "calendar", domain: "school", dueAt: inDays(0.2) }),
    item({ id: "b", domain: "work", meta: { needsReply: true }, surfaceCount: 3, firstSeen: old }),
    item({ id: "c", domain: "school", dueAt: inDays(9), surfaceCount: 3, firstSeen: old }),
    item({ id: "d", source: "note", domain: "projects", kind: "loose-thread", surfaceCount: 3, firstSeen: old }),
    item({ id: "e", domain: "social", dueAt: inDays(4), surfaceCount: 3, firstSeen: old }),
  ];
  const { sections, surfacedIds } = selectForBrief(items, {
    now: NOW, lastBriefAt: "2026-08-18T06:40:00Z", config,
  });
  assert.equal(new Set(surfacedIds).size, surfacedIds.length, "an item was shown twice");
  assert.equal(sections.today?.[0].id, "a");
  assert.equal(sections.work?.[0].id, "b");
  assert.equal(sections.school?.[0].id, "c");
  assert.equal(sections.projects?.[0].id, "d");
  assert.equal(sections.social?.[0].id, "e");
});

test("a work shift and a barbecue on the same day sit in different lanes", () => {
  const old = "2026-08-01T00:00:00Z";
  const items = [
    item({ id: "shift", domain: "work", title: "Shift", dueAt: inDays(3), surfaceCount: 3, firstSeen: old }),
    item({ id: "bbq", domain: "social", title: "End of summer BBQ", dueAt: inDays(3), surfaceCount: 3, firstSeen: old }),
  ];
  const { sections } = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T00:00:00Z", config });
  assert.equal(sections.work?.[0].id, "shift");
  assert.equal(sections.social?.[0].id, "bbq");
});

test("newness and action are flags, not lanes", () => {
  const items = [item({ id: "n", domain: "career", meta: { needsReply: true }, firstSeen: NOW.toISOString() })];
  const { sections, counts } = selectForBrief(items, {
    now: NOW, lastBriefAt: "2026-08-18T06:40:00Z", config,
  });
  assert.equal(sections.career?.[0].id, "n", "still lives in its own lane");
  assert.equal(sections.career[0]._new, true);
  assert.equal(sections.career[0]._needsAction, true);
  assert.equal(counts.new, 1);
  assert.equal(counts.needsAction, 1);
});

test("dismissed and snoozed items never appear", () => {
  const items = [
    item({ id: "x", status: "dismissed", dueAt: inDays(1) }),
    item({ id: "y", status: "done" }),
    item({ id: "z", status: "snoozed", snoozeUntil: inDays(2) }),
  ];
  assert.deepEqual(selectForBrief(items, { now: NOW, config }).surfacedIds, []);
});

test("an expired snooze brings the item back", () => {
  const items = [item({ id: "z", status: "snoozed", snoozeUntil: inDays(-1), dueAt: inDays(3) })];
  assert.deepEqual(selectForBrief(items, { now: NOW, config }).surfacedIds, ["z"]);
});

test("items past the horizon are excluded WITH A STATED REASON, never silently", () => {
  const items = [item({ id: "far", title: "Far off thing", dueAt: inDays(400) })];
  const r = selectForBrief(items, { now: NOW, config });
  assert.deepEqual(r.surfacedIds, []);
  assert.equal(r.excluded.length, 1);
  assert.match(r.excluded[0].why, /days out/);
});

test("NOTHING is truncated — a lane with 40 items shows all 40", () => {
  // The regression this guards: lanes were capped at 6, so 10 of 16 work
  // items vanished with no indication they existed.
  const old = "2026-08-01T00:00:00Z";
  const items = Array.from({ length: 40 }, (_, i) =>
    item({ id: `w${i}`, domain: "work", title: `Work item ${i}`, surfaceCount: 1, firstSeen: old })
  );
  const r = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T00:00:00Z", config });
  assert.equal(r.sections.work.length, 40, "every item must ship to the client");
  assert.equal(r.counts.lanes, 40);
  assert.equal(r.counts.excluded, 0);
});

test("over-repeated items are marked quiet but still present", () => {
  const old = "2026-08-01T00:00:00Z";
  const items = [
    item({ id: "loud", domain: "work", surfaceCount: 0, firstSeen: old }),
    item({ id: "worn", domain: "work", surfaceCount: 99, firstSeen: old }),
  ];
  const r = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T00:00:00Z", config });
  assert.equal(r.sections.work.length, 2, "quiet items still ship");
  assert.equal(r.sections.work.find((i) => i.id === "worn")._quiet, true);
  assert.equal(r.sections.work.find((i) => i.id === "loud")._quiet, false);
  assert.equal(r.counts.quiet, 1);
});

test("the response is stamped with a schema so a stale frontend is detectable", () => {
  assert.equal(selectForBrief([], { now: NOW, config }).schema, SCHEMA);
  assert.equal(SCHEMA, "lanes-v1");
});

test("today reads chronologically, not by rank", () => {
  const items = [
    item({ id: "late", kind: "today", source: "calendar", dueAt: inDays(0.5), categoryWeight: 50 }),
    item({ id: "early", kind: "today", source: "calendar", dueAt: inDays(0.1), categoryWeight: 24 }),
  ];
  const { sections } = selectForBrief(items, { now: NOW, config });
  assert.deepEqual(sections.today.map((i) => i.id), ["early", "late"]);
});

test("lanes read by rank", () => {
  const old = "2026-08-01T00:00:00Z";
  const items = [
    item({ id: "minor", domain: "school", dueAt: inDays(6), categoryWeight: 24, surfaceCount: 3, firstSeen: old }),
    item({ id: "exam", domain: "school", dueAt: inDays(6), categoryWeight: 44, unmissable: true, surfaceCount: 3, firstSeen: old }),
  ];
  const { sections } = selectForBrief(items, { now: NOW, lastBriefAt: "2026-08-18T00:00:00Z", config });
  assert.equal(sections.school[0].id, "exam");
});

test("a quiet day produces an empty brief, not filler", () => {
  const { sections, counts } = selectForBrief([], { now: NOW, config });
  assert.deepEqual(sections, {});
  assert.equal(counts.total, 0);
});

// ====================================================================
group("email triage");

const rules = config.rules;
const msg = (o) => ({ id: "m1", from: "", subject: "", snippet: "", labelIds: [], isNewsletter: false, ...o });

test("an interview outranks everything else", () => {
  const r = triage(msg({ from: "Careers <jobs@corp.com>", subject: "Interview invitation" }), rules);
  assert.equal(r.tier, "opportunity");
  assert.equal(r.score, 100);
});

test("mail from Mom is caught by display name", () => {
  assert.equal(triage(msg({ from: "Mom <someone@gmail.com>", subject: "dinner" }), rules).tier, "family");
});

test("'mom' does not fire on 'moment'", () => {
  assert.equal(triage(msg({ from: "News <a@b.com>", subject: "A moment of your time" }), rules).score, 0);
});

test("the work domain is recognised", () => {
  const domain = rules.domains[0].match;
  assert.equal(triage(msg({ from: `S <s.person@${domain}>`, subject: "rota" }), rules).tier, "work");
});

test("newsletters are dropped", () => {
  const r = triage(msg({ from: "Deals <x@shop.com>", subject: "midterm sale", isNewsletter: true }), rules);
  assert.equal(r.score, 0);
});

test("but a newsletter from a VIP still gets through", () => {
  const r = triage(msg({ from: "Alex Fournier <a.fournier@city.example.ca>", subject: "team update", isNewsletter: true }), rules);
  assert.equal(r.tier, "work");
});

test("muted senders are dropped outright", () => {
  const r = triage(msg({ from: "mailer-daemon@service.com", subject: "Interview" }), rules);
  assert.equal(r.score, 0);
  assert.equal(r.dropped, true, "mute is an absolute veto, distinct from an ordinary zero score");
});

test("an automated sender is no longer muted by default — it can still carry real info", () => {
  // Round 54: noreply@/notifications@ etc. used to be hard-muted, which also
  // ate shipping/appointment mail Jon wanted to see. Only mailer-daemon stays
  // muted now; everything else rides the normal score, and non-task-like
  // survivors land in the Tasks page digest instead of vanishing.
  const r = triage(msg({ from: "noreply@service.com", subject: "Interview" }), rules);
  assert.equal(r.dropped, false);
});

test("ordinary mail scores zero and never reaches the model", () => {
  assert.equal(triage(msg({ from: "Someone <a@b.com>", subject: "hey" }), rules).score, 0);
});

// ====================================================================
group("body and signature matching");

test("a plain email signed by a colleague is caught by the body match", () => {
  const plain = msg({ id: "sig1", from: "Someone <random@gmail.com>", subject: "quick question" });
  assert.equal(triage(plain, rules).score, 0, "header alone finds nothing");

  const boosts = new Map([["sig1", "work"]]);
  const r = triage(plain, rules, boosts);
  assert.equal(r.tier, "work");
  assert.ok(r.reasons.includes("body or signature match"));
});

test("only distinctive terms are ever body-searched", () => {
  assert.equal(isDistinctive("dave leal"), true);
  assert.equal(isDistinctive("richcraft"), true);
  assert.equal(isDistinctive("recreation complex"), true);
  assert.equal(isDistinctive("mom"), false, "would match half the inbox");
  assert.equal(isDistinctive("job"), false);
  assert.equal(isDistinctive("shift"), false);
});

test("boost queries are derived from the rules you already maintain", () => {
  const qs = buildBoostQueries(config);
  const tiers = qs.map((q) => q.tier).sort();
  assert.deepEqual(tiers, ["opportunity", "work"], "school is opted out, family is too generic");

  const work = qs.find((q) => q.tier === "work").query;
  const workplace = config.rules.topics.work.bodyKeywords[0];
  const colleague = config.rules.people.find((p) => p.searchBody).match[0];
  assert.ok(work.includes(workplace), "workplace name should be searched");
  assert.ok(work.includes(`"${colleague}"`), "colleague names should be searched");
  assert.ok(work.includes("in:inbox"), "scoped to the inbox");
  assert.ok(!work.includes("mom"), "generic terms must never reach a body search");
});

console.log(`\n${passed} passed${process.exitCode ? ", WITH FAILURES" : ""}\n`);
