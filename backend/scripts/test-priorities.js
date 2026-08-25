// scripts/test-priorities.js — the "Start here" matching logic, which used
// to attach the right do/why text to the wrong item.
//
// Run: node scripts/test-priorities.js

import assert from "node:assert/strict";
import { filterCandidates, matchPicksToItems, rankFallback } from "../brief/priorities.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const NOW = new Date("2026-08-24T18:00:00Z");
const item = (o) => ({ status: "open", meta: {}, ...o });

group("id-tag matching — the bug this file exists for");

test("a pick is matched to the item whose id it names, never a neighbour", () => {
  const ordered = [
    item({ id: "calendar_caf11e9021de", title: "Summer Schedule Ends", domain: "personal", source: "calendar" }),
    item({ id: "email_5d961f523ebf", title: "Physio appointment reminder", domain: "personal", source: "email" }),
  ];
  const picks = [
    { tag: "email_5d961f523ebf", do: "Cancel physio if not attending", why: "Cancel 24h prior to avoid a fee" },
  ];
  const list = matchPicksToItems(picks, ordered);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "email_5d961f523ebf", "the action lands on the item it actually describes");
  assert.equal(list[0].title, "Physio appointment reminder");
  assert.notEqual(list[0].title, "Summer Schedule Ends",
    "this is exactly the real production mismatch: an unrelated calendar item must never inherit another item's action");
});

test("brackets around the echoed tag are tolerated", () => {
  const ordered = [item({ id: "abc123", title: "X", domain: "personal", source: "email" })];
  const list = matchPicksToItems([{ tag: "[abc123]", do: "Do it", why: "Because" }], ordered);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "abc123");
});

test("a tag the model invented — not in the candidate list — is dropped, not guessed at", () => {
  const ordered = [item({ id: "real_1", title: "Real", domain: "personal", source: "email" })];
  const list = matchPicksToItems([{ tag: "made_up_id", do: "Do it", why: "Because" }], ordered);
  assert.equal(list.length, 0);
});

test("a duplicated tag only ever produces one row", () => {
  const ordered = [item({ id: "a", title: "A", domain: "personal", source: "email" })];
  const list = matchPicksToItems(
    [
      { tag: "a", do: "First", why: "First reason" },
      { tag: "a", do: "Second", why: "Second reason" },
    ],
    ordered
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].do, "First", "the first mention wins, the repeat is ignored");
});

test("results are capped at the limit even if more picks come back", () => {
  const ordered = Array.from({ length: 10 }, (_, i) => item({ id: `i${i}`, title: `T${i}`, domain: "personal", source: "email" }));
  const picks = ordered.map((it) => ({ tag: it.id, do: "Do it", why: "Because" }));
  const list = matchPicksToItems(picks, ordered, 6);
  assert.equal(list.length, 6);
});

test("do/why are trimmed and length-capped, missing ones fall back to null", () => {
  const ordered = [item({ id: "a", title: "A", domain: "personal", source: "email" })];
  const list = matchPicksToItems([{ tag: "a", do: `  ${"x".repeat(100)}  `, why: 42 }], ordered);
  assert.equal(list[0].do.length, 80);
  assert.equal(list[0].why, null, "a non-string why is not coerced into text");
});

group("staleness — undated Start-here candidates age out");

test("an undated item within the window is a candidate", () => {
  const items = [item({ id: "a", title: "A", firstSeen: new Date(NOW.getTime() - 1 * 86400000).toISOString() })];
  const out = filterCandidates(items, NOW, {});
  assert.equal(out.length, 1);
});

test("an undated item past the window drops out on its own", () => {
  const items = [item({ id: "a", title: "A", firstSeen: new Date(NOW.getTime() - 5 * 86400000).toISOString() })];
  const out = filterCandidates(items, NOW, {});
  assert.equal(out.length, 0, "default cap is 2 days");
});

test("the cap is configurable via config.display.undatedMaxAgeDays", () => {
  const items = [item({ id: "a", title: "A", firstSeen: new Date(NOW.getTime() - 5 * 86400000).toISOString() })];
  const out = filterCandidates(items, NOW, { display: { undatedMaxAgeDays: 10 } });
  assert.equal(out.length, 1);
});

test("a dated item is never dropped for age — its own due date governs it", () => {
  const items = [
    item({
      id: "a", title: "A",
      dueAt: new Date(NOW.getTime() + 30 * 86400000).toISOString(),
      firstSeen: new Date(NOW.getTime() - 400 * 86400000).toISOString(),
    }),
  ];
  const out = filterCandidates(items, NOW, {});
  assert.equal(out.length, 1);
});

test("a stale undated item falls back to lastSeen when firstSeen is missing", () => {
  const items = [item({ id: "a", title: "A", lastSeen: new Date(NOW.getTime() - 5 * 86400000).toISOString() })];
  const out = filterCandidates(items, NOW, {});
  assert.equal(out.length, 0);
});

test("done and dismissed items are excluded regardless of age", () => {
  const items = [
    item({ id: "a", title: "A", status: "done", firstSeen: NOW.toISOString() }),
    item({ id: "b", title: "B", status: "dismissed", firstSeen: NOW.toISOString() }),
  ];
  const out = filterCandidates(items, NOW, {});
  assert.equal(out.length, 0);
});

test("an unmissable calendar item without a due date is still excluded — calendar always needs a date", () => {
  const items = [item({ id: "a", title: "A", source: "calendar", unmissable: true, firstSeen: NOW.toISOString() })];
  const out = filterCandidates(items, NOW, {});
  assert.equal(out.length, 0);
});

group("ranking still runs over whatever survives the filter");

test("rankFallback puts the nearest due date first", () => {
  const items = [
    item({ id: "far", title: "Far", dueAt: new Date(NOW.getTime() + 20 * 86400000).toISOString() }),
    item({ id: "near", title: "Near", dueAt: new Date(NOW.getTime() + 1 * 86400000).toISOString() }),
  ];
  const ranked = rankFallback(items, NOW);
  assert.equal(ranked[0].id, "near");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
