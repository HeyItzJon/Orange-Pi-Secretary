// scripts/seed-demo.js — fake items for testing the brief without live APIs.
// Not part of the app. Run: node scripts/seed-demo.js
import { init, upsertMany, setMeta } from "../lib/store.js";
import { itemId, contentHash } from "../lib/ids.js";

const now = Date.now();
const inDays = (n) => new Date(now + n * 86400000).toISOString();
const mk = (o) => ({ url: null, dueAt: null, reasons: [], meta: {}, contentHash: contentHash(o), ...o });

await init();

await upsertMany([
  mk({ id: itemId("calendar", "c1"), source: "calendar", kind: "today", title: "MSE 3401 lecture",
       detail: "School & Classes", dueAt: new Date(new Date().setHours(9, 30, 0, 0)).toISOString(),
       priority: 75, tier: "school", meta: { allDay: false } }),
  mk({ id: itemId("calendar", "c2"), source: "calendar", kind: "today", title: "Shift — 12:00 to 5:00",
       detail: "WORK", dueAt: new Date(new Date().setHours(12, 0, 0, 0)).toISOString(),
       priority: 75, tier: "school", meta: { allDay: false } }),
  mk({ id: itemId("calendar", "c3"), source: "calendar", kind: "today", title: "UAV Design Team meeting",
       detail: "IMPORTANT EVENTS", dueAt: new Date(new Date().setHours(20, 0, 0, 0)).toISOString(),
       priority: 95, tier: "important", meta: { allDay: false, needsPrep: true } }),

  mk({ id: itemId("email", "e1"), source: "email", kind: "needs-reply",
       title: "Mandatory eLearning module due Aug 31", detail: "City of Ottawa HR — Training reminder",
       url: "https://mail.google.com", dueAt: inDays(12), priority: 97, tier: "work",
       meta: { needsReply: true } }),
  mk({ id: itemId("email", "e2"), source: "email", kind: "needs-reply",
       title: "Prof. Reid needs your lab partner confirmation", detail: "Prof. Reid — MSE 3401 lab groups",
       url: "https://mail.google.com", dueAt: inDays(2), priority: 83, tier: "school",
       meta: { needsReply: true } }),
  mk({ id: itemId("email", "e3"), source: "email", kind: "fyi",
       title: "Co-op posting closes Sept 2 — resume and cover letter", detail: "Co-op Office — Fall postings",
       url: "https://mail.google.com", dueAt: inDays(14), priority: 100, tier: "opportunity" }),

  mk({ id: itemId("calendar", "c4"), source: "calendar", kind: "upcoming", title: "MSE 3401 midterm",
       detail: "Tests & Quizzes · 7:00 PM", dueAt: inDays(7), priority: 90, tier: "important" }),

  mk({ id: itemId("note", "n1"), source: "note", kind: "loose-thread",
       title: '"Look into CCO vs CCJ overlap"', detail: "Uranium · Areas/Finances/Investments · untouched 23d",
       priority: 43, tier: "note", meta: { age: 23 } }),
  mk({ id: itemId("note", "n2"), source: "note", kind: "loose-thread",
       title: '"Email Prof. Chen re: summer research"', detail: "Research ideas · Projects/School · untouched 11d",
       priority: 41, tier: "note", meta: { age: 11 } }),
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
