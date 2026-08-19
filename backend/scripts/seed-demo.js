// scripts/seed-demo.js — fake items for testing the brief without live APIs.
// Not part of the app. Run: node scripts/seed-demo.js
//
// The detail strings here are written the way sources/calendar.js would
// actually produce them: notes, durations, locations — never the calendar's
// own name, and never a repeat of the title.

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
  // --- today -------------------------------------------------------------
  mk({ id: itemId("calendar", "c1"), source: "calendar", kind: "today",
       title: "MSE 3401 lecture", detail: "50 min · Colonel By Hall",
       dueAt: at(9, 30), category: "class", categoryLabel: "Class", categoryWeight: 34,
       tier: "class", meta: { allDay: false, recurring: true } }),

  mk({ id: itemId("calendar", "c2"), source: "calendar", kind: "today",
       title: "Shift", detail: "5h · Richcraft Recreation Complex",
       dueAt: at(12), category: "work", categoryLabel: "Work", categoryWeight: 40,
       tier: "work", meta: { allDay: false, recurring: true } }),

  mk({ id: itemId("calendar", "c5"), source: "calendar", kind: "today",
       title: "PHYSIO", detail: "45 min · Kanata Physiotherapy",
       dueAt: at(17, 30), category: "appointment", categoryLabel: "Appointment",
       categoryWeight: 26, emphasised: true, tier: "appointment",
       reasons: ["written in caps"], meta: { allDay: false } }),

  mk({ id: itemId("calendar", "c3"), source: "calendar", kind: "today",
       title: "UAV Design Team meeting",
       detail: "Bring the revised airframe drawings · 1h 30m · 6 people",
       dueAt: at(20), category: "important", categoryLabel: "Important",
       categoryWeight: 42, unmissable: true, tier: "important",
       meta: { allDay: false, needsPrep: true, attendees: 6 } }),

  // --- needs you ---------------------------------------------------------
  mk({ id: itemId("email", "e1"), source: "email", kind: "needs-reply",
       title: "Mandatory eLearning module — 40 min, blocks your next shift",
       detail: "Dave Leal · body or signature match",
       url: "https://mail.google.com", dueAt: inDays(12),
       category: "work", categoryLabel: "Work", categoryWeight: 40,
       tier: "work", reasons: ["body or signature match"], meta: { needsReply: true } }),

  mk({ id: itemId("email", "e2"), source: "email", kind: "needs-reply",
       title: "Pick a lab partner or one gets assigned to you",
       detail: "Prof. Reid · mentions \"lab report\"",
       url: "https://mail.google.com", dueAt: inDays(2),
       category: "class", categoryLabel: "Class", categoryWeight: 34,
       tier: "school", meta: { needsReply: true } }),

  // --- new since yesterday ----------------------------------------------
  mk({ id: itemId("email", "e3"), source: "email", kind: "fyi",
       title: "Fall co-op postings open — 14 roles, resume required",
       detail: "Co-op Office · mentions \"co-op\"",
       url: "https://mail.google.com", dueAt: inDays(14),
       category: "opportunity", categoryLabel: "Opportunity", categoryWeight: 48,
       tier: "opportunity" }),

  // --- coming up ---------------------------------------------------------
  mk({ id: itemId("calendar", "c4"), source: "calendar", kind: "upcoming",
       title: "MSE 3401 midterm", detail: "7:00 PM · 2h · Minto Centre",
       dueAt: inDays(7), category: "assessment", categoryLabel: "Test",
       categoryWeight: 44, unmissable: true, tier: "assessment" }),

  // --- loose threads -----------------------------------------------------
  mk({ id: itemId("note", "n1"), source: "note", kind: "loose-thread",
       title: '"Look into CCO vs CCJ overlap"',
       detail: "Uranium · Areas/Finances/Investments",
       category: "note", categoryLabel: "Loose thread", categoryWeight: 15,
       tier: "note", meta: { age: 23 } }),

  mk({ id: itemId("note", "n2"), source: "note", kind: "loose-thread",
       title: '"Email Prof. Chen re: summer research"',
       detail: "Research ideas · Projects/School",
       category: "note", categoryLabel: "Loose thread", categoryWeight: 13,
       tier: "note", meta: { age: 11 } }),
]);

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
