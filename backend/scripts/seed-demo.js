// scripts/seed-demo.js — fake items for testing the brief without live APIs.
// Not part of the app. Run: node scripts/seed-demo.js
//
// Detail strings are written the way sources/calendar.js actually produces
// them: notes, durations, locations — never the calendar's own name, never a
// repeat of the title.

import { init, upsertMany, setMeta } from "../lib/store.js";
import { itemId, contentHash } from "../lib/ids.js";

const now = Date.now();
const inDays = (n) => new Date(now + n * 86400000).toISOString();
const at = (h, m = 0) => new Date(new Date().setHours(h, m, 0, 0)).toISOString();
const mk = (o) => ({
  url: null, dueAt: null, reasons: [], meta: {}, unmissable: false,
  emphasised: false, contentHash: contentHash(o), ...o,
});

await init();

await upsertMany([
  // --- today: the timeline. Domains deliberately mixed. -------------------
  mk({ id: itemId("calendar", "c1"), source: "calendar", kind: "today",
       title: "MSE 3401 lecture", detail: "50 min · Colonel By Hall", dueAt: at(9, 30),
       category: "class", categoryLabel: "Class", categoryWeight: 34, domain: "school",
       tier: "class", meta: { allDay: false, recurring: true, end: at(10, 20) } }),

  mk({ id: itemId("calendar", "c2"), source: "calendar", kind: "today",
       title: "Shift — 12:00 to 17:00", detail: "5h · Riverside Recreation Complex", dueAt: at(12),
       category: "work", categoryLabel: "Work", categoryWeight: 40, domain: "work",
       tier: "work", meta: { allDay: false, recurring: true, end: at(17) } }),

  mk({ id: itemId("calendar", "c5"), source: "calendar", kind: "today",
       title: "PHYSIO", detail: "45 min · Kanata Physiotherapy", dueAt: at(17, 30),
       category: "appointment", categoryLabel: "Appointment", categoryWeight: 26,
       domain: "personal", emphasised: true, tier: "appointment",
       reasons: ["written in caps"], meta: { allDay: false, end: at(18, 15) } }),

  mk({ id: itemId("calendar", "c6"), source: "calendar", kind: "today",
       title: "End of summer BBQ", detail: "Bring something for the grill · 3h · Britannia Park",
       dueAt: at(19), category: "personal", categoryLabel: "Personal", categoryWeight: 24,
       domain: "social", tier: "personal", meta: { allDay: false, end: at(22), attendees: 12 } }),

  // --- school lane -------------------------------------------------------
  mk({ id: itemId("email", "e2"), source: "email", kind: "needs-reply",
       title: "Pick a lab partner or one gets assigned to you",
       detail: "Prof. Reid · mentions \"lab report\"",
       url: "https://mail.google.com", dueAt: inDays(2),
       category: "class", categoryLabel: "Class", categoryWeight: 34, domain: "school",
       tier: "school", meta: { needsReply: true } }),

  mk({ id: itemId("calendar", "c4"), source: "calendar", kind: "upcoming",
       title: "MSE 3401 midterm", detail: "7:00 PM · 2h · Minto Centre", dueAt: inDays(7),
       category: "assessment", categoryLabel: "Test", categoryWeight: 44,
       domain: "school", unmissable: true, tier: "assessment" }),

  // --- work lane ---------------------------------------------------------
  mk({ id: itemId("email", "e1"), source: "email", kind: "needs-reply",
       title: "Mandatory eLearning module — 40 min, blocks your next shift",
       detail: "Alex Fournier · body or signature match",
       url: "https://mail.google.com", dueAt: inDays(12),
       category: "work", categoryLabel: "Work", categoryWeight: 40, domain: "work",
       tier: "work", reasons: ["body or signature match"], meta: { needsReply: true } }),

  // --- career lane -------------------------------------------------------
  mk({ id: itemId("email", "e3"), source: "email", kind: "fyi",
       title: "Fall co-op postings open — 14 roles, resume required",
       detail: "Co-op Office · mentions \"co-op\"",
       url: "https://mail.google.com", dueAt: inDays(14),
       category: "opportunity", categoryLabel: "Opportunity", categoryWeight: 48,
       domain: "career", tier: "opportunity" }),

  // --- social lane -------------------------------------------------------
  mk({ id: itemId("calendar", "c7"), source: "calendar", kind: "upcoming",
       title: "Sarah's wedding", detail: "all day · Chateau Montebello", dueAt: inDays(11),
       category: "critical", categoryLabel: "Can't miss", categoryWeight: 50,
       domain: "social", unmissable: true, tier: "critical",
       meta: { allDay: true } }),

  // --- projects lane -----------------------------------------------------
  mk({ id: itemId("calendar", "c3"), source: "calendar", kind: "upcoming",
       title: "UAV Design Team meeting",
       detail: "Bring the revised airframe drawings · 1h 30m · 6 people", dueAt: inDays(1),
       category: "important", categoryLabel: "Important", categoryWeight: 42,
       domain: "projects", unmissable: true, tier: "important",
       meta: { allDay: false, needsPrep: true, attendees: 6, end: new Date(new Date(inDays(1)).getTime() + 5400000).toISOString() } }),

  mk({ id: itemId("note", "n2"), source: "note", kind: "loose-thread",
       title: '"Email Prof. Chen re: summer research"',
       detail: "Research ideas · Projects/School",
       category: "note", categoryLabel: "Loose thread", categoryWeight: 13,
       domain: "projects", tier: "note", meta: { age: 11 } }),

  // --- finance lane ------------------------------------------------------
  mk({ id: itemId("note", "n1"), source: "note", kind: "loose-thread",
       title: '"Look into CCO vs CCJ overlap"',
       detail: "Uranium · Areas/Finances/Investments",
       category: "note", categoryLabel: "Loose thread", categoryWeight: 15,
       domain: "finance", tier: "note", meta: { age: 23 } }),
]);


// --- a realistic pile of work mail, to prove nothing gets truncated -------
const workSubjects = [
  "Beaverbrook shifts available :: Aug 19-21",
  "RRCK :: Training compliance :: eLearning due",
  "Beav LTS Done - Schedule Next Week",
  "Beaverbrook :: August Aquatic In-service :: RSVP",
  "Re: RRCK HIG Hours :: Aug 13, 14, 16, 17",
  "Training Tonight CANCELLED",
  "Rejected Hours",
  "Fwd: Beav Replacement",
  "Public swim Saturday August 8th Beaverbrook",
  "RE: Shift Covers",
];
await upsertMany(workSubjects.map((t, i) => mk({
  id: itemId("email", `w${i}`), source: "email", kind: "fyi", title: t,
  detail: "Aquatics team · mentions \"beaverbrook\"",
  url: "https://mail.google.com",
  category: "work", categoryLabel: "Work", categoryWeight: 40, domain: "work",
  tier: "work", meta: {},
})));

await setMeta("moneySummary", {
  at: new Date().toISOString(), total: 63780.42, dayPct: 0.42,
  holdingCount: 40, unavailable: 0, stale: 0, holdings: [],
});
await setMeta("lastBriefAt", new Date(now - 86400000).toISOString());
for (const s of ["email", "calendar", "money", "notes"]) {
  await setMeta(`lastRun_${s}`, new Date(now - 3600000).toISOString());
}

console.log("seeded");
process.exit(0);
