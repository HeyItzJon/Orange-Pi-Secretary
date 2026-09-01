// scripts/test-email.js — the deterministic (no network, no AI) parts of
// sources/email.js: triage scoring, boost-query building, and the prompt
// builder that now prefers a full fetched body over the old 220-char
// snippet (see collectEmail()'s step 6). collectEmail() itself is not
// tested here — it's almost entirely network calls (Gmail, the AI classify
// call) end to end; the pure pieces it's built from are what's covered.
//
// Run: node scripts/test-email.js

import assert from "node:assert/strict";
import { isDistinctive, buildBoostQueries, triage, buildClassifyPrompt } from "../sources/email.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

// ====================================================================
group("isDistinctive — only specific terms are worth a full-text search");

test("a short common word is not distinctive enough to search bodies for", () => {
  assert.equal(isDistinctive("mom"), false);
  assert.equal(isDistinctive("job"), false);
});

test("a long single word, or a multi-word phrase, is distinctive", () => {
  assert.equal(isDistinctive("richcraft"), true);
  assert.equal(isDistinctive("Priya Raman"), true);
});

// ====================================================================
group("buildBoostQueries — turns searchBody rules into Gmail full-text queries");

test("only rules flagged searchBody contribute a query, grouped by tier", () => {
  const config = {
    rules: {
      people: [
        { tier: "family", match: ["Priya Raman"], searchBody: true },
        { tier: "work", match: ["Alex Fournier"], searchBody: false },
      ],
      topics: {
        housing: { searchBody: true, bodyKeywords: ["richcraft"] },
      },
    },
  };
  const queries = buildBoostQueries(config);
  const byTier = Object.fromEntries(queries.map((q) => [q.tier, q.query]));
  assert.ok(byTier.family?.includes('"Priya Raman"'));
  assert.ok(!("work" in byTier), "searchBody: false must not produce a query");
  assert.ok(byTier.housing?.includes("richcraft"));
});

test("a non-distinctive keyword never makes it into the query even if searchBody is on", () => {
  const config = { rules: { topics: { chat: { searchBody: true, bodyKeywords: ["hi"] } } } };
  assert.deepEqual(buildBoostQueries(config), []);
});

// ====================================================================
group("triage — deterministic scoring, no tokens spent");

const rules = {
  mute: ["noreply@spammy.com"],
  people: [{ tier: "family", label: "Mom", match: ["Priya Raman"], searchBody: true }],
  domains: [{ tier: "work", label: "employer", match: "richcraft.com" }],
  topics: { assignment: { score: 65, keywords: ["assignment", "due"] } },
  tierScores: { family: 90, work: 80 },
};

test("a muted sender scores zero no matter what else matches", () => {
  const msg = { from: "Newsletter <noreply@spammy.com>", subject: "assignment due", snippet: "" };
  assert.deepEqual(triage(msg, rules), { score: 0, tier: null, reasons: ["muted sender"], dropped: true });
});

test("a named person in the From header scores that person's tier", () => {
  const msg = { from: "Priya Raman <priya@gmail.com>", subject: "Hi", snippet: "" };
  const r = triage(msg, rules);
  assert.equal(r.score, 90);
  assert.equal(r.tier, "family");
});

test("a known employer domain scores its own tier", () => {
  const msg = { from: "Shift Bot <no-reply@richcraft.com>", subject: "Your shift", snippet: "" };
  const r = triage(msg, rules);
  assert.equal(r.score, 80);
  assert.equal(r.tier, "work");
});

test("a topic keyword in the subject/snippet scores that topic", () => {
  const msg = { from: "prof@school.edu", subject: "MSE 3401 assignment due Friday", snippet: "" };
  const r = triage(msg, rules);
  assert.equal(r.score, 65);
  assert.equal(r.tier, "assignment");
});

test("a body/signature match (a full-text boost hit) scores its tier even with a plain subject", () => {
  const msg = { id: "m1", from: "random@example.com", subject: "Quick update", snippet: "" };
  const boosts = new Map([["m1", "family"]]);
  const r = triage(msg, rules, boosts);
  assert.equal(r.score, 90);
  assert.equal(r.tier, "family");
});

test("an unclaimed newsletter is dropped entirely", () => {
  const msg = { from: "digest@newsletter.com", subject: "This week's picks", snippet: "", isNewsletter: true };
  assert.deepEqual(triage(msg, rules), { score: 0, tier: null, reasons: ["newsletter"], dropped: true });
});

test("a newsletter that also matches a real rule (family/work/opportunity) is NOT dropped", () => {
  const msg = { from: "Priya Raman <priya@gmail.com>", subject: "Hi", snippet: "", isNewsletter: true };
  const r = triage(msg, rules);
  assert.equal(r.tier, "family", "a claimed sender survives the newsletter filter");
});

test("Gmail's own IMPORTANT label nudges an already-scored email up, but never promotes a zero", () => {
  const scored = { from: "Priya Raman <priya@gmail.com>", subject: "Hi", snippet: "", labelIds: ["IMPORTANT"] };
  assert.equal(triage(scored, rules).score, 92, "small tiebreaker nudge on top of the real score");

  const unscored = { from: "nobody@example.com", subject: "nothing", snippet: "", labelIds: ["IMPORTANT"] };
  assert.equal(triage(unscored, rules).score, 0, "IMPORTANT alone never manufactures a score");
});

// ====================================================================
group("buildClassifyPrompt — full body text, not the truncated snippet");

test("uses the fetched full body when present, ignoring the shorter snippet", () => {
  const candidates = [
    {
      msg: { from: "Registrar <reg@school.edu>", subject: "Tuition", snippet: "Reminder: tuition..." },
      body: "Reminder: tuition is due September 2nd. Late fees apply after that date if unpaid.",
    },
  ];
  const prompt = buildClassifyPrompt(candidates, "2026-08-26");
  assert.ok(prompt.includes("September 2nd"), "the real body text made it into the prompt");
  assert.ok(prompt.includes("Late fees apply"), "text past where the old 220-char snippet would have cut off");
});

test("falls back to the snippet when the full-body fetch failed for that message (empty body)", () => {
  const candidates = [
    { msg: { from: "a@b.com", subject: "Subj", snippet: "Only the snippet survived" }, body: "" },
  ];
  const prompt = buildClassifyPrompt(candidates, "2026-08-26");
  assert.ok(prompt.includes("Only the snippet survived"));
});

test("body text is capped so one very long email can't blow out the token budget", () => {
  const longBody = "x".repeat(5000);
  const candidates = [{ msg: { from: "a@b.com", subject: "Subj", snippet: "" }, body: longBody }];
  const prompt = buildClassifyPrompt(candidates, "2026-08-26");
  const bodyLine = prompt.split("\n").find((l) => l.trim().startsWith("Body:"));
  assert.ok(bodyLine.length < 3100, "capped well under the full 5000 chars");
});

test("numbers each email in order and includes sender and subject", () => {
  const candidates = [
    { msg: { from: "Alex Fournier <alex@work.com>", subject: "Shift swap", snippet: "" }, body: "Can you cover Friday?" },
    { msg: { from: "Priya Raman <mom@home.com>", subject: "Dinner", snippet: "" }, body: "Come by at 6." },
  ];
  const prompt = buildClassifyPrompt(candidates, "2026-08-26");
  assert.ok(prompt.includes("1. From: Alex Fournier"));
  assert.ok(prompt.includes("2. From: Priya Raman"));
  assert.ok(prompt.includes("for these 2 email(s)"));
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
