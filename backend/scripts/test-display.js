// scripts/test-display.js
//
// Tests for the always-on screen's model. Pure, so no Gmail, no model, no
// dependence on the real clock.
//
//   node scripts/test-display.js

import assert from "node:assert/strict";
import {
  buildDisplay, hourOfDay, distanceLabel, chunkFor, priorityWord, durationLabel, freshness,
  isTaskLike, buildTasks, updatedLabel, dayKey, weekForecast,
} from "../brief/display.js";

const TZ = "America/Toronto";
const config = { timezone: TZ, display: { days: 3, maxDeadlines: 8, movers: 3 } };

// Aug 19 2026, 12:20 PM Toronto (EDT = UTC-4)
const NOW = new Date("2026-08-19T16:20:00Z");
const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 19, h + 4, m)).toISOString();
const dayAt = (n, h, m = 0) => new Date(Date.UTC(2026, 7, 19 + n, h + 4, m)).toISOString();

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
}
function group(n) { console.log(`\n${n}\n`); }

const ev = (o) => ({
  source: "calendar", kind: "upcoming", status: "open", title: "Event",
  detail: "", unmissable: false, emphasised: false, meta: {}, ...o,
});

// ====================================================================
group("time in words");

test("hour of day respects the configured timezone, not the server's", () => {
  assert.equal(hourOfDay("2026-08-19T16:20:00Z", TZ), 12 + 20 / 60);
  assert.equal(hourOfDay("2026-08-19T16:20:00Z", "UTC"), 16 + 20 / 60);
});

test("distances read the way a person would say them", () => {
  assert.equal(distanceLabel(40 * 60000), "40 min");
  assert.equal(distanceLabel(90 * 60000), "1h 30m");
  assert.equal(distanceLabel(2 * 3600000), "2h");
  assert.equal(distanceLabel(30000), "now");
});

test("the day divides into named chunks", () => {
  assert.equal(chunkFor(8), "Morning");
  assert.equal(chunkFor(13), "Afternoon");
  assert.equal(chunkFor(19), "Evening");
  assert.equal(chunkFor(23), "Night");
});

test("durations are human", () => {
  assert.equal(durationLabel(at(9), at(9, 50)), "50 min");
  assert.equal(durationLabel(at(9), at(11)), "2h");
  assert.equal(durationLabel(at(9), at(10, 30)), "1h 30m");
  assert.equal(durationLabel(at(9), at(9), true), "all day");
});

// ====================================================================
group("priority in plain words, not badges");

test("each priority is a phrase you can read", () => {
  assert.equal(priorityWord({ unmissable: true }), "can't miss");
  assert.equal(priorityWord({ emphasised: true }), "you flagged it");
  assert.equal(priorityWord({ meta: { needsReply: true } }), "needs a reply");
  assert.equal(priorityWord({ meta: { needsPrep: true } }), "needs prep");
  assert.equal(priorityWord({ meta: { recurring: true } }), "routine");
  assert.equal(priorityWord({ meta: {} }), null, "most things say nothing");
});

// ====================================================================
group("the NOW line");

test("an event in progress says when it ends", () => {
  const items = [ev({ id: "a", title: "Shift", dueAt: at(12), meta: { end: at(17), location: "Beaverbrook" } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.hero.kind, "running");
  assert.match(d.hero.lead, /Shift until 5:00 PM/);
});

test("an event within 2 hours counts down to it", () => {
  const items = [ev({ id: "a", title: "Shift", dueAt: at(13), meta: { end: at(16) } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.hero.kind, "soon");
  assert.match(d.hero.lead, /Shift in 40 min/);
  assert.equal(d.hero.urgent, true);
});

test("beyond 2 hours it goes calm and tells you how long you're free", () => {
  const items = [ev({ id: "a", title: "Physio", dueAt: at(17, 30), meta: { end: at(18, 15) } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.hero.kind, "later");
  assert.match(d.hero.lead, /Nothing until Physio, 5:30 PM/);
  assert.equal(d.hero.urgent, false, "a free afternoon must not look like an alarm");
});

test("an empty day says so plainly", () => {
  const d = buildDisplay({ items: [], config, now: NOW });
  assert.equal(d.hero.kind, "clear");
  assert.match(d.hero.lead, /Nothing else scheduled/);
});

// ====================================================================
group("the day strip");

test("blocks land where the events actually are", () => {
  const items = [ev({ id: "a", title: "Shift", dueAt: at(13), meta: { end: at(16) } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  // default window is 7am -> 11pm (16 hours), so 1pm is (13-7)/16 = 37.5%, 3 hours wide = 18.75%
  assert.equal(Math.round(strip.blocks[0].left), 38);
  assert.equal(Math.round(strip.blocks[0].width), 19);
});

test("the now-marker tracks the clock", () => {
  const { strip } = buildDisplay({ items: [], config, now: NOW });
  assert.equal(Math.round(strip.nowPct), 33); // 12:20 in the default 7am-11pm window
});

test("with nothing outside the ordinary day, the window stays at 7am-11pm", () => {
  const items = [ev({ id: "a", title: "Lunch", dueAt: at(12), meta: { end: at(13) } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.startHour, 7);
  assert.equal(strip.endHour, 23);
});

test("an early event pulls the start of the window open to fit it", () => {
  const items = [ev({ id: "a", title: "Flight", dueAt: at(5), meta: { end: at(6) } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.startHour, 5);
  assert.equal(strip.blocks[0].left, 0, "the 5am event that opened the window should itself sit at the very start");
});

test("a late event pulls the end of the window open to fit it", () => {
  const items = [ev({ id: "a", title: "Red-eye", dueAt: at(23, 30), meta: { end: at(23, 55) } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.endHour, 24);
});

test("an event before the window's 4am floor still shows, pinned to the left edge rather than clipped off", () => {
  const items = [ev({ id: "a", title: "Very early", dueAt: at(1), meta: { end: at(1, 30) } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.startHour, 4, "the window opens for an early event, but not past a 4am floor");
  assert.equal(strip.blocks[0].left, 0);
});

test("chunks are labelled, not clock ticks", () => {
  const { strip } = buildDisplay({ items: [], config, now: NOW });
  assert.deepEqual(strip.chunks.map((c) => c.label), ["Morning", "Afternoon", "Evening", "Night"]);
});

test("all-day events never become blocks", () => {
  const items = [ev({ id: "a", title: "Weekend", dueAt: at(0), meta: { allDay: true } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks.length, 0);
});

test("all-day events show up as their own chips on the strip instead", () => {
  const items = [ev({ id: "a", title: "Essay due", dueAt: at(0), meta: { allDay: true }, swatch: "deadline", color: "#e67c73" })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.allDay.length, 1);
  assert.equal(strip.allDay[0].title, "Essay due");
  assert.equal(strip.allDay[0].swatch, "deadline");
  assert.equal(strip.allDay[0].color, "#e67c73");
});

test("a timed event today never shows up as an all-day chip", () => {
  const items = [ev({ id: "a", title: "Standup", dueAt: at(9), meta: { end: at(9, 30) } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.allDay.length, 0);
});

test("all-day chips lead with can't-miss, then flagged, then alphabetical", () => {
  const items = [
    ev({ id: "z", title: "Zoo trip", dueAt: at(0), meta: { allDay: true } }),
    ev({ id: "a", title: "Assignment", dueAt: at(0), meta: { allDay: true } }),
    ev({ id: "f", title: "Flagged thing", dueAt: at(0), meta: { allDay: true }, emphasised: true }),
    ev({ id: "m", title: "Must attend", dueAt: at(0), meta: { allDay: true }, unmissable: true }),
  ];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.deepEqual(strip.allDay.map((c) => c.id), ["m", "f", "a", "z"]);
  assert.equal(strip.allDay[0].priority, "can't miss");
});

test("a block's colour is the item's real swatch when it has one", () => {
  const items = [ev({ id: "a", title: "Interview", dueAt: at(13), swatch: "opportunity", domain: "career" })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].swatch, "opportunity");
});

test("an item collected before swatch existed still gets the default-calendar override", () => {
  // meta.calendarName is rewritten to the literal string "Personal" ONLY for
  // the email-named default calendar (see sources/calendar.js) — this is the
  // real bug: an un-migrated Physio event was falling all the way through to
  // domain ("personal"), landing on the same colour as Gym Schedule instead
  // of the light-blue override its calendar is supposed to get.
  const items = [ev({
    id: "a", title: "Physio", dueAt: at(13),
    domain: "personal", meta: { calendarName: "Personal" }, // no swatch field
  })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].swatch, "gmail");
});

test("a real calendar named literally 'Gym Schedule' still falls back to domain, not gmail", () => {
  const items = [ev({
    id: "a", title: "Leg day", dueAt: at(13),
    domain: "personal", meta: { calendarName: "Gym Schedule" },
  })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].swatch, "personal");
});

test("a block carries the item's real Google calendar colour when it has one", () => {
  const items = [ev({ id: "a", title: "Standup", dueAt: at(9), swatch: "work", color: "#7986cb" })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].color, "#7986cb");
});

test("a block with no colour on record comes back null, not a guessed value", () => {
  const items = [ev({ id: "a", title: "Old item", dueAt: at(9), swatch: "work" })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].color, null);
});

test("two events that don't intersect in time are not flagged as overlapping", () => {
  const items = [
    ev({ id: "a", title: "First", dueAt: at(9), meta: { end: at(10) } }),
    ev({ id: "b", title: "Second", dueAt: at(10), meta: { end: at(11) } }),
  ];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].overlap, false);
  assert.equal(strip.blocks[1].overlap, false);
});

test("two events that genuinely overlap are both flagged, independent of colour", () => {
  const items = [
    ev({ id: "a", title: "Long thing", dueAt: at(9), meta: { end: at(13) }, color: "#7986cb" }),
    ev({ id: "b", title: "Even more thing", dueAt: at(12), meta: { end: at(14) }, color: "#e67c73" }),
  ];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.blocks[0].overlap, true);
  assert.equal(strip.blocks[1].overlap, true);
  // the flag never touches colour — each keeps its own real calendar colour
  assert.equal(strip.blocks[0].color, "#7986cb");
  assert.equal(strip.blocks[1].color, "#e67c73");
});

test("a third event that overlaps neither of two overlapping ones is not flagged", () => {
  const items = [
    ev({ id: "a", title: "A", dueAt: at(9), meta: { end: at(11) } }),
    ev({ id: "b", title: "B", dueAt: at(10), meta: { end: at(12) } }),
    ev({ id: "c", title: "C", dueAt: at(14), meta: { end: at(15) } }),
  ];
  const { strip } = buildDisplay({ items, config, now: NOW });
  const byId = Object.fromEntries(strip.blocks.map((b) => [b.id, b]));
  assert.equal(byId.a.overlap, true);
  assert.equal(byId.b.overlap, true);
  assert.equal(byId.c.overlap, false);
});

// ====================================================================
group("dayStrips — the forward-day carousel, same graphic as the day strip");

test("dayStrips carries exactly the next 3 days, forward only", () => {
  const { dayStrips } = buildDisplay({ items: [], config, now: NOW });
  assert.equal(dayStrips.length, 3);
  assert.deepEqual(dayStrips.map((d) => d.key), ["2026-08-20", "2026-08-21", "2026-08-22"]);
});

test("dayStrips labels read the same way as the NEXT 3 DAYS list: Tomorrow, then weekday names", () => {
  const { dayStrips } = buildDisplay({ items: [], config, now: NOW });
  assert.equal(dayStrips[0].label, "Tomorrow");
  assert.equal(dayStrips[1].label, "Friday", "Aug 21 2026 is a Friday");
  assert.equal(dayStrips[1].dateLabel, "Friday, August 21");
});

test("a future day's blocks land at the same position the day strip itself would compute", () => {
  const items = [ev({ id: "a", title: "Standup", dueAt: dayAt(1, 9), meta: { end: dayAt(1, 10) } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[0].blocks.length, 1);
  // default 7am-11pm window: 9am is (9-7)/16 = 12.5%
  assert.equal(Math.round(dayStrips[0].blocks[0].left), 13);
  assert.equal(dayStrips[0].blocks[0].label, "Standup");
});

test("a future day's blocks never carry a now-marker or a past flag — nothing on it has happened yet", () => {
  const items = [ev({ id: "a", title: "Standup", dueAt: dayAt(1, 9), meta: { end: dayAt(1, 10) } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[0].nowPct, undefined);
  assert.equal(dayStrips[0].blocks[0].past, false);
});

test("an all-day item on a future day shows up in that day's own chip row, not today's or another day's", () => {
  const items = [ev({ id: "pd", title: "Payday", dueAt: dayAt(2, 0), meta: { allDay: true } })];
  const { strip, dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.allDay.length, 0);
  assert.equal(dayStrips[0].allDay.length, 0);
  assert.deepEqual(dayStrips[1].allDay.map((c) => c.title), ["Payday"]);
  assert.equal(dayStrips[2].allDay.length, 0);
});

test("an event on day 3 opens that day's own window early/late, independent of today's or day 2's", () => {
  const items = [ev({ id: "a", title: "Flight", dueAt: dayAt(3, 5), meta: { end: dayAt(3, 5, 30) } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[2].startHour, 5);
  assert.equal(dayStrips[0].startHour, 7, "an unrelated day must not inherit day 3's early window");
});

test("a dayStrips day's summary: nothing at all reads plainly, not as a guess", () => {
  const { dayStrips } = buildDisplay({ items: [], config, now: NOW });
  assert.equal(dayStrips[0].summary, "Nothing scheduled yet");
});

test("a dayStrips day's summary: one timed event names itself and its time of day", () => {
  const items = [ev({ id: "a", title: "Shift", dueAt: dayAt(1, 18), meta: { end: dayAt(1, 22) } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[0].summary, "Shift in the evening");
});

test("a dayStrips day's summary: two timed events are both named", () => {
  const items = [
    ev({ id: "a", title: "Standup", dueAt: dayAt(1, 9), meta: { end: dayAt(1, 9, 30) } }),
    ev({ id: "b", title: "Gym", dueAt: dayAt(1, 18), meta: { end: dayAt(1, 19) } }),
  ];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[0].summary, "Standup and Gym");
});

test("a dayStrips day's summary: three or more leads with the one the existing priority rules favour", () => {
  const items = [
    ev({ id: "a", title: "Standup", dueAt: dayAt(1, 9), meta: { end: dayAt(1, 9, 30) } }),
    ev({ id: "b", title: "Gym", dueAt: dayAt(1, 18), meta: { end: dayAt(1, 19) } }),
    ev({ id: "c", title: "Exam", dueAt: dayAt(1, 13), meta: { end: dayAt(1, 15) }, unmissable: true }),
  ];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[0].summary, "3 things on your schedule, including Exam");
});

test("a dayStrips day's summary: only an all-day item, no timed events, describes that instead", () => {
  const items = [ev({ id: "a", title: "Payday", dueAt: "2026-08-20", meta: { allDay: true } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[0].summary, "Payday, all day");
});

// ====================================================================
group("today, days, deadlines");

test("today lists what's LEFT, with location, duration and prep", () => {
  const items = [
    ev({ id: "past", title: "Done already", dueAt: at(9), meta: { end: at(10) } }),
    ev({ id: "next", title: "UAV meeting", dueAt: at(20),
         detail: "Bring the airframe drawings · 1h 30m · Minto Centre",
         meta: { end: at(21, 30), needsPrep: true } }),
  ];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.today.length, 1, "finished events drop off");
  assert.equal(d.today[0].title, "UAV meeting");
  assert.equal(d.today[0].duration, "1h 30m");
  assert.equal(d.today[0].prep, "Bring the airframe drawings");
  assert.equal(d.today[0].priority, "needs prep");
});

test("the next days are grouped, and tomorrow is called tomorrow", () => {
  const items = [
    ev({ id: "t1", title: "Beav shift", dueAt: dayAt(1, 7, 30), meta: { end: dayAt(1, 9) } }),
    ev({ id: "t2", title: "BBQ", dueAt: dayAt(2, 18), meta: { end: dayAt(2, 21) } }),
  ];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.days.length, 3);
  assert.equal(d.days[0].label, "Tomorrow");
  assert.equal(d.days[0].items[0].title, "Beav shift");
  assert.equal(d.days[0].items[0].chunk, "Morning", "labelled by chunk, not just a clock time");
  assert.equal(d.days[1].items[0].chunk, "Evening");
  assert.equal(d.days[2].clear, true);
});

test("nothing appears in both the day list and deadlines", () => {
  const items = [
    ev({ id: "soon", title: "Tomorrow thing", dueAt: dayAt(1, 10), meta: { end: dayAt(1, 11) } }),
    ev({ id: "far", title: "Far thing", dueAt: dayAt(20, 10), meta: { end: dayAt(20, 11) } }),
  ];
  const d = buildDisplay({ items, config, now: NOW });
  const dayIds = d.days.flatMap((x) => x.items.map((i) => i.id));
  const dlIds = d.deadlines.map((x) => x.id);
  assert.ok(dayIds.includes("soon"));
  assert.ok(dlIds.includes("far"));
  assert.equal(dlIds.filter((i) => dayIds.includes(i)).length, 0, "no duplication between zones");
});

test("deadlines are capped, ordered, and flag the near ones", () => {
  const items = Array.from({ length: 14 }, (_, i) =>
    ev({ id: `d${i}`, source: "email", kind: "fyi", title: `Deadline ${i}`, dueAt: dayAt(i + 2, 12) })
  );
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.deadlines.length, 8, "capped at maxDeadlines");
  assert.equal(d.deadlines[0].title, "Deadline 0", "soonest first");
  assert.equal(d.deadlines[0].near, true);
  assert.equal(d.deadlines[7].near, false);
});

test("done, dismissed and snoozed items never reach the screen", () => {
  const items = [
    ev({ id: "a", title: "Done", dueAt: dayAt(5, 12), status: "done" }),
    ev({ id: "b", title: "Dismissed", dueAt: dayAt(5, 12), status: "dismissed" }),
    ev({ id: "c", title: "Snoozed", dueAt: dayAt(5, 12), status: "snoozed", snoozeUntil: dayAt(3, 0) }),
  ];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.deadlines.length, 0);
});

// ====================================================================
group("portfolio snapshot");

const money = {
  base: "CAD", total: 63780.42, dayPct: 0.42, dayChangeValue: 267.1,
  weekPct: 2.1, monthPct: -0.8, holdingCount: 8, stale: [], unavailable: [],
  fx: { USD: 1.381 }, historyDays: 14, marketState: "REGULAR", marketStatus: "markets open", holdingsFrom: "vault",
  // `value` is what decides ordering and weight now, and every one of these is
  // already converted to CAD by money.js — mixing currencies here was the bug.
  positions: [
    { ticker: "DNA", dayChangePct: 18.1, value: 1200, currency: "USD", price: 12.3, shares: 97, weightPct: 1.9, dayChangeValue: 184 },
    { ticker: "ARKG", dayChangePct: 10.5, value: 900, currency: "USD", price: 30.1, shares: 30, weightPct: 1.4, dayChangeValue: 86 },
    { ticker: "ARKK", dayChangePct: 5.3, value: 800, currency: "USD", price: 80.2, shares: 10, weightPct: 1.3, dayChangeValue: 40 },
    { ticker: "SOFI", dayChangePct: 5.8, value: 700, currency: "USD", price: 14.0, shares: 50, weightPct: 1.1, dayChangeValue: 38 },
    { ticker: "VFV.TO", dayChangePct: 0.1, value: 20000, currency: "CAD", price: 160.0, shares: 125, weightPct: 31.4, dayChangeValue: 20 },
    { ticker: "MDA.TO", dayChangePct: -5.5, value: 1500, currency: "CAD", price: 30.0, shares: 50, weightPct: 2.4, dayChangeValue: -87 },
    { ticker: "LUNR", dayChangePct: -6.7, value: 600, currency: "USD", price: 12.0, shares: 50, weightPct: 0.9, dayChangeValue: -43 },
    { ticker: "VNP.TO", dayChangePct: -5.2, value: 1100, currency: "CAD", price: 22.0, shares: 50, weightPct: 1.7, dayChangeValue: -60 },
  ],
};

test("the biggest movers surface, both directions", () => {
  const { portfolio } = buildDisplay({ items: [], money, config, now: NOW });
  assert.deepEqual(portfolio.up.map((m) => m.ticker), ["DNA", "ARKG", "SOFI"], "capped by display.movers");
  assert.deepEqual(portfolio.down.map((m) => m.ticker), ["LUNR", "MDA", "VNP"]);
});

test("exchange suffixes are stripped — the screen is narrow", () => {
  const { portfolio } = buildDisplay({ items: [], money, config, now: NOW });
  assert.ok(!portfolio.down.some((m) => m.ticker.includes(".")));
});

test("stale prices are never counted as movers", () => {
  const m = { ...money, positions: [{ ticker: "X", dayChangePct: 40, value: 100, stale: true }] };
  const { portfolio } = buildDisplay({ items: [], money: m, config, now: NOW });
  assert.equal(portfolio.up.length, 0);
});

test("every position is listed, biggest first — the book is not a fixed list", () => {
  const { portfolio } = buildDisplay({ items: [], money, config, now: NOW });
  assert.equal(portfolio.positions.length, 8, "all of them, not a top N");
  assert.equal(portfolio.positions[0].display, "VFV", "largest by value leads");
  assert.ok(portfolio.positions[0].weightPct > portfolio.positions[1].weightPct);
});

test("the base currency and FX rate travel with the numbers", () => {
  const { portfolio } = buildDisplay({ items: [], money, config, now: NOW });
  assert.equal(portfolio.base, "CAD");
  assert.equal(portfolio.fx.USD, 1.381, "so the page can show what rate was used");
});

test("a price that failed to refresh is named, not folded into a count", () => {
  const m = { ...money, stale: ["MDA.TO"], unavailable: ["XYZ"] };
  const { portfolio } = buildDisplay({ items: [], money: m, config, now: NOW });
  assert.deepEqual(portfolio.staleTickers, ["MDA"]);
  assert.deepEqual(portfolio.missingTickers, ["XYZ"]);
});

test("no portfolio data means no portfolio zone, not a zero", () => {
  const d = buildDisplay({ items: [], money: null, config, now: NOW });
  assert.equal(d.portfolio, null);
});

// ====================================================================
group("freshness — the screen has to admit when it stopped being true");

const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();

test("it reports the age of the DATA, not of the redraw", () => {
  const f = freshness({ email: ago(12), calendar: ago(8) }, { now: NOW });
  assert.equal(f.label, "checked 12 min ago", "the OLDEST live source wins");
  assert.equal(f.stale, false);
});

test("hours are said as hours", () => {
  assert.equal(freshness({ email: ago(600), calendar: ago(5) }, { now: NOW }).label, "checked 10h ago");
});

test("past the threshold it goes stale, which triggers the self-heal", () => {
  assert.equal(freshness({ email: ago(60), calendar: ago(60) }, { now: NOW, staleAfterHours: 8 }).stale, false);
  assert.equal(freshness({ email: ago(700), calendar: ago(60) }, { now: NOW, staleAfterHours: 8 }).stale, true);
});

test("never having run is stale, not fresh", () => {
  const f = freshness({ email: null, calendar: null }, { now: NOW });
  assert.equal(f.label, "never checked");
  assert.equal(f.stale, true);
});

test("money and notes run daily, so they don't drag the freshness reading", () => {
  const f = freshness({ email: ago(5), calendar: ago(5), money: ago(1400), notes: ago(1400) }, { now: NOW });
  assert.equal(f.stale, false, "a once-a-day source being a day old is normal");
});

test("a FAILING source is named, not silently treated as fresh", () => {
  // The bug this guards: runSources stamped lastRun even on failure, so a dead
  // Gmail token read as "just checked" forever on a screen you can't click.
  const f = freshness({ email: ago(5), calendar: ago(5) }, {
    now: NOW, errors: { email: { message: "invalid_grant" } },
  });
  assert.deepEqual(f.broken, ["email"]);
  assert.match(f.problem, /email failing/);
});

test("no errors means no problem line", () => {
  const f = freshness({ email: ago(5), calendar: ago(5) }, { now: NOW, errors: { email: null } });
  assert.deepEqual(f.broken, []);
  assert.equal(f.problem, null);
});

test("freshness rides along on the display model", () => {
  const d = buildDisplay({ items: [], sources: { email: ago(5), calendar: ago(5) }, config, now: NOW });
  assert.equal(d.freshness.stale, false);
});


// ====================================================================
group("the tasks page — what you owe, as opposed to where you must be");

const task = (o) => ({ status: "open", meta: {}, title: "T", ...o });

test("events are not tasks, but all-day entries and assessments are", () => {
  assert.equal(isTaskLike(task({ source: "calendar", meta: { end: at(14) } })), false,
    "a 1-to-2 meeting is somewhere you go");
  assert.equal(isTaskLike(task({ source: "calendar", meta: { allDay: true } })), true,
    "an all-day entry is how most people write a due date");
  assert.equal(isTaskLike(task({ source: "calendar", category: "assessment" })), true);
  assert.equal(isTaskLike(task({ source: "calendar", title: "MSE 3401 lab report due" })), true);
  assert.equal(isTaskLike(task({ source: "email", meta: { needsReply: true } })), true);
  assert.equal(isTaskLike(task({ source: "email", meta: {} })), false,
    "most mail is not an obligation");
  assert.equal(isTaskLike(task({ source: "vault" })), false,
    "the vault is life context now, not a task source");
});

test('"due" only matches the whole word, never inside another one', () => {
  assert.equal(isTaskLike(task({ source: "calendar", title: "Duel practice" })), false);
});

test("tasks fall into time buckets rather than one long sorted list", () => {
  const t = buildTasks([
    task({ id: "a", source: "calendar", meta: { allDay: true }, title: "Late thing", dueAt: dayAt(-2, 9) }),
    task({ id: "b", source: "calendar", meta: { allDay: true }, title: "Today thing", dueAt: at(23) }),
    task({ id: "c", source: "calendar", meta: { allDay: true }, title: "Soon thing", dueAt: dayAt(3, 9) }),
    task({ id: "d", source: "calendar", meta: { allDay: true }, title: "Far thing", dueAt: dayAt(40, 9) }),
    task({ id: "e", source: "email", title: "Undated", meta: { needsReply: true } }),
  ], { now: NOW, tz: TZ, config });
  assert.deepEqual(t.groups.map((g) => g.key), ["overdue", "today", "week", "later", "someday"]);
  assert.equal(t.total, 5);
  assert.equal(t.urgent, 2, "overdue and due-today are what the tab badge counts");
});

test("email tasks arrive one per row, labelled with the note they came from", () => {
  const t = buildTasks(
    ["Finish the ACB sheet", "Reconcile March", "Email the T5008"].map((title, i) =>
      task({ id: `n${i}`, source: "email", title, meta: { needsReply: true, note: "ACB", age: 12 } })
    ),
    { now: NOW, tz: TZ, config }
  );
  const some = t.groups.find((g) => g.key === "someday");
  assert.equal(some.items.length, 3);
  assert.equal(some.items[0].originLabel, "Email");
  assert.equal(some.items[0].context, "ACB", "the note it came from");
});

test("a priority the model picked floats to the top of its bucket and carries its action", () => {
  const rows = ["Rewire the IMU", "Pick a domain name", "Resolve Altium licensing"].map((title, i) =>
    task({ id: `v${i}`, source: "email", title, meta: { needsReply: true, note: "Drone", age: 9 } })
  );
  const t = buildTasks(rows, {
    now: NOW, tz: TZ, config,
    priorities: [{ id: "v2", do: "Email CPRT about an Altium seat", why: "Blocks the PCB review" }],
  });
  const some = t.groups.find((g) => g.key === "someday");
  assert.equal(some.items[0].title, "Resolve Altium licensing");
  assert.equal(some.items[0].do, "Email CPRT about an Altium seat");
  assert.equal(some.items[0].top, true);
  assert.equal(some.items[1].top, false, "unpicked rows keep their own order below");
});

test("one noisy origin cannot bury a genuine deadline", () => {
  const noise = Array.from({ length: 30 }, (_, i) =>
    task({ id: `n${i}`, source: "email", title: `Note ${i}`, meta: { needsReply: true, note: `Note ${i}` } })
  );
  const t = buildTasks([
    ...noise,
    task({ id: "real", source: "calendar", meta: { allDay: true }, title: "Tuition due", dueAt: dayAt(2, 9) }),
  ], { now: NOW, tz: TZ, config });
  const week = t.groups.find((g) => g.key === "week");
  assert.equal(week.items[0].title, "Tuition due", "each group is capped separately");
  const some = t.groups.find((g) => g.key === "someday");
  assert.equal(some.items.length, 8);
  assert.equal(some.hidden, 22, "the overflow is counted, not silently dropped");
});

test("the display model carries the tasks page and a badge count", () => {
  const d = buildDisplay({
    items: [task({ id: "x", source: "calendar", meta: { allDay: true }, title: "Essay due", dueAt: at(23) })],
    config, now: NOW,
  });
  assert.equal(d.schema, "display-v2");
  assert.deepEqual(d.pages.map((p) => p.id), ["today", "week", "tasks", "money", "year"]);
  assert.equal(d.pages.find((p) => p.id === "tasks").badge, 1);
});

test("the menu reads Today, Week, Tasks, Finances, Year — Money's tab is labelled Finances", () => {
  const d = buildDisplay({ items: [], config, now: NOW });
  assert.deepEqual(d.pages.map((p) => p.label), ["Today", "Week", "Tasks", "Finances", "Year"]);
});

test("the Money and Year tabs never carry a badge — nothing on either page explains one", () => {
  // A real money alert (the kind that used to size the Money badge) and a
  // year nowhere near 0% or 100% (so its own badge wouldn't just happen to
  // be falsy) — both still shouldn't put a number in the tab.
  const items = [
    { id: "m1", source: "money", kind: "drift", status: "open", title: "ARKG is 9% of the book vs 3% target", categoryWeight: 24 },
  ];
  const d = buildDisplay({ items, money, config, now: NOW });
  const moneyTab = d.pages.find((p) => p.id === "money");
  const yearTab = d.pages.find((p) => p.id === "year");
  assert.equal(moneyTab.badge, null);
  assert.equal(yearTab.badge, null);
});

// ====================================================================
group("last updated — a clock reading, not a countdown, and shared everywhere");

test("updatedLabel is just the time when the pull was earlier today", () => {
  assert.equal(updatedLabel(at(9, 5), TZ, dayKey(NOW, TZ)), "9:05 AM");
});

test("updatedLabel adds the date once the pull is from a different day", () => {
  assert.equal(updatedLabel(dayAt(-1, 9), TZ, dayKey(NOW, TZ)), "Aug 18, 9:00 AM");
});

test("updatedLabel is null with nothing to report", () => {
  assert.equal(updatedLabel(null, TZ, dayKey(NOW, TZ)), null);
});

test("the header's lastUpdatedLabel tracks the OLDER of email and calendar, not the newer", () => {
  const d = buildDisplay({
    items: [], config, now: NOW,
    sources: { email: at(10), calendar: at(8) },
  });
  assert.equal(d.lastUpdatedLabel, "8:00 AM", "calendar pulled earlier — that's the true last-updated");
});

test("lastUpdatedLabel is null when neither live source has ever run, even if money has", () => {
  const d = buildDisplay({ items: [], config, now: NOW, sources: { money: at(9) } });
  assert.equal(d.lastUpdatedLabel, null);
});

test("the Money page's updatedLabel tracks money's own pull, independent of email/calendar", () => {
  const d = buildDisplay({
    items: [], money, config, now: NOW,
    sources: { email: at(10), calendar: at(8), money: dayAt(-1, 7) },
  });
  assert.equal(d.portfolio.updatedLabel, "Aug 18, 7:00 AM");
  assert.equal(d.lastUpdatedLabel, "8:00 AM", "unaffected by money's own pull time");
});

test("the Year page's own copy stays in sync with the Money page's — same basis, computed once", () => {
  const d = buildDisplay({ items: [], money, config, now: NOW, sources: { money: at(9, 30) } });
  assert.equal(d.year.moneyUpdatedLabel, d.portfolio.updatedLabel);
});

// ====================================================================
group("week forecast — busy vs. free, no guessed durations");

test("with nothing on the calendar, every day is fully free", () => {
  const w = weekForecast([], [], { now: NOW, tz: TZ, days: 3 });
  assert.equal(w.days.length, 3);
  for (const day of w.days) {
    assert.equal(day.busyHours, 0);
    assert.equal(day.freeHours, w.wakeHours);
    assert.equal(day.load, 0);
  }
});

test("a single event eats exactly its own hours out of the waking window", () => {
  const events = [ev({ id: "e1", dueAt: at(9), meta: { end: at(11) } })];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].busyHours, 2);
  assert.equal(w.days[0].freeHours, w.wakeHours - 2);
  assert.equal(w.days[0].eventCount, 1);
});

test("overlapping events merge instead of double-counting", () => {
  const events = [
    ev({ id: "e1", dueAt: at(9), meta: { end: at(11) } }),
    ev({ id: "e2", dueAt: at(10), meta: { end: at(12) } }),
  ];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].busyHours, 3, "9am-12pm merged, not 4 hours of double-booked time");
});

test("all-day events don't count as busy hours", () => {
  const events = [ev({ id: "e1", dueAt: at(0), meta: { allDay: true, end: at(23) } })];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].busyHours, 0);
  assert.equal(w.days[0].eventCount, 0);
});

test("an all-day event still shows up on its own day's badge, even though the bar itself stays untouched", () => {
  const events = [ev({ id: "e1", title: "Report due", dueAt: at(0), meta: { allDay: true }, swatch: "deadline" })];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 2 });
  assert.equal(w.days[0].allDay.length, 1);
  assert.equal(w.days[0].allDay[0].title, "Report due");
  assert.equal(w.days[0].allDay[0].swatch, "deadline");
  assert.equal(w.days[1].allDay.length, 0, "a different day must not pick up another day's all-day item");
  // untouched, same as the existing "don't count as busy hours" test above
  assert.equal(w.days[0].busyHours, 0);
  assert.equal(w.days[0].freeHours, w.wakeHours);
});

test("multiple all-day items on the same week day all land on that day's badge, ordered the same way as the strip", () => {
  const events = [
    ev({ id: "z", title: "Zoo trip", dueAt: at(0), meta: { allDay: true } }),
    ev({ id: "m", title: "Must attend", dueAt: at(0), meta: { allDay: true }, unmissable: true }),
  ];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.deepEqual(w.days[0].allDay.map((c) => c.id), ["m", "z"]);
});

test("an event outside the waking window is clipped to it, not counted in full", () => {
  const events = [ev({ id: "e1", dueAt: at(5), meta: { end: at(8) } })]; // 5am-8am, window opens at 7
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1, wakeStart: 7, wakeEnd: 23 });
  assert.equal(w.days[0].busyHours, 1, "only 7am-8am falls inside the window");
});

test("each day's bar carries a coloured segment per event, sized and positioned like the day strip", () => {
  const events = [ev({ id: "e1", dueAt: at(9), swatch: "class", meta: { end: at(11) } })];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1, wakeStart: 7, wakeEnd: 23 });
  const seg = w.days[0].segments[0];
  // 16h window: 9am is (9-7)/16 = 12.5%, 2h wide = 12.5%
  assert.equal(Math.round(seg.left), 13);
  assert.equal(Math.round(seg.width), 13);
  assert.equal(seg.swatch, "class");
});

test("a week-bar segment carries the item's real Google calendar colour too, same as the day strip", () => {
  const events = [ev({ id: "e1", dueAt: at(9), swatch: "class", color: "#33b679", meta: { end: at(11) } })];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].segments[0].color, "#33b679");
});

test("a week-bar segment with no colour on record comes back null", () => {
  const events = [ev({ id: "e1", dueAt: at(9), swatch: "class", meta: { end: at(11) } })];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].segments[0].color, null);
});

test("overlapping events each keep their own segment on the bar, unmerged — busyHours still merges", () => {
  const events = [
    ev({ id: "e1", dueAt: at(9), swatch: "work", meta: { end: at(11) } }),
    ev({ id: "e2", dueAt: at(10), swatch: "class", meta: { end: at(12) } }),
  ];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].segments.length, 2, "the bar should still show both events, not one merged block");
  assert.equal(w.days[0].busyHours, 3, "merging is still the right call for the busy-hours number itself");
});

test("today/tomorrow read as words, later days as the weekday name", () => {
  const w = weekForecast([], [], { now: NOW, tz: TZ, days: 3 });
  assert.equal(w.days[0].label, "Today");
  assert.equal(w.days[1].label, "Tomorrow");
  assert.equal(w.days[2].label, "Friday", "Aug 21 2026 is a Friday");
});

test("looming lists what's due inside the window, soonest first, and nothing past it", () => {
  const tasks = [
    ev({ id: "past", title: "Already due", dueAt: dayAt(-1, 12), meta: { allDay: true } }),
    ev({ id: "in3", title: "Report", dueAt: dayAt(3, 9), meta: { allDay: true } }),
    ev({ id: "in1", title: "Form", dueAt: dayAt(1, 9), meta: { allDay: true } }),
    ev({ id: "far", title: "Way out", dueAt: dayAt(30, 9), meta: { allDay: true } }),
  ];
  const w = weekForecast([], tasks, { now: NOW, tz: TZ, days: 7 });
  assert.deepEqual(w.looming.map((i) => i.id), ["in1", "in3"], "soonest first, past and far-future excluded");
  assert.equal(w.looming[0].in, "tomorrow");
});

test("buildDisplay wires week in as a badge-less page", () => {
  const items = [ev({ id: "e1", dueAt: at(9), meta: { end: at(11) } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.week.days.length, 7, "defaults to a week");
  const page = d.pages.find((p) => p.id === "week");
  assert.equal(page.label, "Week");
  assert.equal(page.badge, null);
});

// ====================================================================
group("busyness score — a 1-10 read of how loaded a day is, for the Week page");

test("an empty day floors at 1, not 0 — a 1-10 scale has no zero", () => {
  const w = weekForecast([], [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(w.days[0].busyness, 1);
  assert.deepEqual(w.days[0].busynessWhy, []);
});

test("busyness never exceeds 10 even on a genuinely packed day", () => {
  const events = [
    ev({ id: "a", dueAt: at(7), categoryWeight: 50, unmissable: true, meta: { end: at(11) } }),
    ev({ id: "b", dueAt: at(11), categoryWeight: 50, unmissable: true, meta: { end: at(15) } }),
    ev({ id: "c", dueAt: at(15), categoryWeight: 50, unmissable: true, meta: { end: at(19) } }),
    ev({ id: "d", dueAt: at(19), categoryWeight: 50, unmissable: true, meta: { end: at(23) } }),
  ];
  const w = weekForecast(events, [], { now: NOW, tz: TZ, days: 1 });
  assert.ok(w.days[0].busyness <= 10);
  assert.equal(w.days[0].busyness, 10);
});

test("more busy hours score at least as high as fewer, all else equal", () => {
  const short = [ev({ id: "a", dueAt: at(9), meta: { end: at(10) } })];
  const long = [ev({ id: "a", dueAt: at(9), meta: { end: at(15) } })];
  const wShort = weekForecast(short, [], { now: NOW, tz: TZ, days: 1 });
  const wLong = weekForecast(long, [], { now: NOW, tz: TZ, days: 1 });
  assert.ok(wLong.days[0].busyness >= wShort.days[0].busyness);
});

test("a heavier category scores higher than a casual one at the same busy hours", () => {
  const casual = [ev({ id: "a", dueAt: at(9), categoryWeight: 24, meta: { end: at(11) } })];
  const heavy = [ev({ id: "a", dueAt: at(9), categoryWeight: 50, meta: { end: at(11) } })];
  const wCasual = weekForecast(casual, [], { now: NOW, tz: TZ, days: 1 });
  const wHeavy = weekForecast(heavy, [], { now: NOW, tz: TZ, days: 1 });
  assert.ok(wHeavy.days[0].busyness > wCasual.days[0].busyness);
});

test("an all-day item nudges the score up even though it never touches busyHours", () => {
  const withAllDay = [ev({ id: "a", dueAt: at(0), meta: { allDay: true } })];
  const wEmpty = weekForecast([], [], { now: NOW, tz: TZ, days: 1 });
  const wAllDay = weekForecast(withAllDay, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(wAllDay.days[0].busyHours, 0, "still shouldn't count as busy time");
  assert.ok(wAllDay.days[0].busyness > wEmpty.days[0].busyness);
  assert.ok(wAllDay.days[0].busynessWhy.some((w) => w.includes("all-day")));
});

test("an unmissable event raises the score even when it's short", () => {
  const casual = [ev({ id: "a", dueAt: at(9), meta: { end: at(9, 30) } })];
  const critical = [ev({ id: "a", dueAt: at(9), unmissable: true, meta: { end: at(9, 30) } })];
  const wCasual = weekForecast(casual, [], { now: NOW, tz: TZ, days: 1 });
  const wCritical = weekForecast(critical, [], { now: NOW, tz: TZ, days: 1 });
  assert.ok(wCritical.days[0].busyness > wCasual.days[0].busyness);
  assert.ok(wCritical.days[0].busynessWhy.some((w) => w.includes("can't miss")));
});

test("several short separate events score higher than one block of the same total length", () => {
  const oneBlock = [ev({ id: "a", dueAt: at(9), meta: { end: at(12) } })];
  const fragmented = [
    ev({ id: "a", dueAt: at(9), meta: { end: at(10) } }),
    ev({ id: "b", dueAt: at(10), meta: { end: at(11) } }),
    ev({ id: "c", dueAt: at(11), meta: { end: at(12) } }),
  ];
  const wBlock = weekForecast(oneBlock, [], { now: NOW, tz: TZ, days: 1 });
  const wFrag = weekForecast(fragmented, [], { now: NOW, tz: TZ, days: 1 });
  assert.equal(wBlock.days[0].busyHours, wFrag.days[0].busyHours, "same total hours either way");
  assert.ok(wFrag.days[0].busyness > wBlock.days[0].busyness, "but fragmentation should cost something");
});

// ====================================================================
// Google's actual all-day payload: a bare "YYYY-MM-DD" string, with no
// dateTime, no time, no offset (see lib/google.js's getEvents(): `start:
// e.start?.dateTime || e.start?.date`). at()/dayAt() above build full ISO
// datetimes with the Toronto offset already baked in, which is NOT what a
// real all-day event's dueAt looks like — every test above them exercised
// a shape the real bug never touched. new Date("2026-08-19") parses as UTC
// midnight; converting that instant to America/Toronto (UTC-4 in August)
// lands on Aug 18, one day early. These tests use the literal bare strings
// to reproduce Jon's actual report: an all-day item due "today" (Aug 19)
// and one due "Thursday" (Aug 20, i.e. tomorrow in this fixture) both
// failed to show up, and a couple showed up on the wrong day entirely.
group("all-day events as Google actually sends them (bare YYYY-MM-DD dates)");

const TODAY_STR = "2026-08-19";   // NOW is Aug 19, 12:20 PM Toronto
const THURS_STR = "2026-08-20";   // tomorrow in this fixture — stands in for Jon's "Thursday"
const FRIDAY_STR = "2026-08-21";
const FAR_STR = "2026-08-24";     // Monday, past the 3-day day-card window (config.display.days = 3)

test("a bare-date all-day event due today shows up as a strip chip", () => {
  const items = [ev({ id: "dw", title: "Don't wanna", dueAt: TODAY_STR, meta: { allDay: true } })];
  const { strip } = buildDisplay({ items, config, now: NOW });
  assert.deepEqual(strip.allDay.map((c) => c.title), ["Don't wanna"],
    "a bare date string for TODAY must not be read as yesterday");
});

test("a bare-date all-day event due today shows up in rest-of-today, and doesn't steal the hero's NOW/NEXT", () => {
  const items = [
    ev({ id: "dw", title: "Don't wanna", dueAt: TODAY_STR, meta: { allDay: true } }),
    ev({ id: "shift", title: "Shift", dueAt: at(17, 30), meta: { end: at(18, 15) } }),
  ];
  const d = buildDisplay({ items, config, now: NOW });
  assert.ok(d.today.some((i) => i.title === "Don't wanna" && i.time === "all day"),
    "today's all-day item belongs in the rest-of-today list");
  assert.equal(d.hero.kind, "later");
  assert.match(d.hero.lead, /Shift/, "the hero's NEXT must be the real timed event, not the all-day chip");
});

test("with only an all-day event today and nothing timed, the hero still reads clear rather than crashing on a fake NEXT", () => {
  const items = [ev({ id: "dw", title: "Don't wanna", dueAt: TODAY_STR, meta: { allDay: true } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.hero.kind, "clear");
});

test("a bare-date all-day event due tomorrow (Jon's 'Thursday') lands on the correct week-view day badge, not the day before", () => {
  const items = [ev({ id: "pd", title: "Payday", dueAt: THURS_STR, meta: { allDay: true } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.equal(d.week.days[0].allDay.length, 0, "must not leak backward onto today");
  assert.deepEqual(d.week.days[1].allDay.map((c) => c.title), ["Payday"], "Tomorrow's badge is where it belongs");
});

test("a recurring bare-date all-day event on a later day also lands correctly", () => {
  const items = [ev({ id: "pd2", title: "Payday", dueAt: FRIDAY_STR, meta: { allDay: true, recurring: true } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.deepEqual(d.week.days[2].allDay.map((c) => c.title), ["Payday"]);
  assert.equal(d.week.days[1].allDay.length, 0);
});

test("weekForecast's looming counts a bare-date all-day item as due tomorrow, not today (off-by-one guard)", () => {
  const tasks = [ev({ id: "pd", title: "Payday", dueAt: THURS_STR, meta: { allDay: true } })];
  const w = weekForecast([], tasks, { now: NOW, tz: TZ, days: 7 });
  assert.equal(w.looming.length, 1);
  assert.equal(w.looming[0].in, "tomorrow");
});

test("weekForecast's looming counts a bare-date all-day item due today as due today, not yesterday", () => {
  const tasks = [ev({ id: "dw", title: "Don't wanna", dueAt: TODAY_STR, meta: { allDay: true } })];
  const w = weekForecast([], tasks, { now: NOW, tz: TZ, days: 7 });
  assert.equal(w.looming.length, 1, "must still be inside the window, not excluded as already-past");
  assert.equal(w.looming[0].in, "today");
});

test("buildTasks buckets a bare-date all-day item due today as 'today', not 'overdue'", () => {
  const t = buildTasks([
    task({ id: "dw", source: "calendar", meta: { allDay: true }, title: "Don't wanna", dueAt: TODAY_STR }),
  ], { now: NOW, tz: TZ, config });
  const today = t.groups.find((g) => g.key === "today");
  assert.equal(today.items.length, 1);
  assert.equal(today.items[0].title, "Don't wanna");
});

test("buildTasks buckets a bare-date all-day item due tomorrow as 'week', not 'today'", () => {
  const t = buildTasks([
    task({ id: "pd", source: "calendar", meta: { allDay: true }, title: "Payday", dueAt: THURS_STR }),
  ], { now: NOW, tz: TZ, config });
  const week = t.groups.find((g) => g.key === "week");
  assert.equal(week.items.length, 1);
  assert.equal(week.items[0].title, "Payday");
  assert.equal(t.groups.find((g) => g.key === "today"), undefined,
    "empty groups are dropped, not left in as empty — 'today' must not appear at all");
});

test("the Tasks-page sidebar (deadlines) picks up a bare-date all-day item beyond the day-card window and labels it correctly", () => {
  // Within config.display.days (3), a calendar event already appears on its
  // own day card, so `deadlines` correctly excludes it via shownIds — this
  // uses a date past that window to test deadlines itself, not the day cards.
  const items = [ev({ id: "pd", title: "Tuition", dueAt: FAR_STR, meta: { allDay: true } })];
  const d = buildDisplay({ items, config, now: NOW });
  const found = d.deadlines.find((x) => x.title === "Tuition");
  assert.ok(found, "must appear in the deadlines sidebar at all");
  assert.equal(found.in, "5 days", "Aug 24 is 5 days after Aug 19, not 4 (the old off-by-one)");
});

test("dayKey() itself: a bare date string is returned as-is, never shifted a day earlier by timezone conversion", () => {
  assert.equal(dayKey(TODAY_STR, TZ), TODAY_STR);
  assert.equal(dayKey(THURS_STR, TZ), THURS_STR);
});

// ====================================================================
// Jon: "I see that payday is never shown on Thursday" — traced to every
// day-matching filter comparing an all-day event's dueAt against a single
// day, when Google's all-day events (per calendar.js) always carry an
// EXCLUSIVE end date too, even single-day ones. A start-only match happens
// to work for a single-day event (its own day is the only day it could
// match) but silently drops a genuinely multi-day all-day event — a trip,
// a conference, a multi-day reminder some calendar sync created — from
// every day after its first. eventOnDay() (unexported, exercised here only
// through buildDisplay/weekForecast) is the fix: a real range check against
// meta.end rather than a plain equality against dueAt alone.
group("multi-day all-day events (Google's exclusive end date)");

test("a 2-day all-day event shows on BOTH days it covers, not just its start day", () => {
  // Aug 19 (today) through Aug 21 EXCLUSIVE — Google's convention — covers
  // Aug 19 and Aug 20 only, not Aug 21.
  const items = [ev({ id: "conf", title: "Conference", dueAt: TODAY_STR, meta: { allDay: true, end: FRIDAY_STR } })];
  const { strip, dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.deepEqual(strip.allDay.map((c) => c.title), ["Conference"], "today, its first day");
  assert.deepEqual(dayStrips[0].allDay.map((c) => c.title), ["Conference"], "tomorrow, its second day");
});

test("...but stops exactly at its exclusive end date — the day after must not also show it", () => {
  const items = [ev({ id: "conf", title: "Conference", dueAt: TODAY_STR, meta: { allDay: true, end: FRIDAY_STR } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(dayStrips[1].allDay.length, 0, "Friday is the exclusive end date — the event doesn't reach it");
});

test("a single-day all-day event (end = start + 1 day, Google's normal case) still shows on exactly one day", () => {
  const items = [ev({ id: "pd", title: "Payday", dueAt: THURS_STR, meta: { allDay: true, end: FRIDAY_STR } })];
  const { strip, dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.equal(strip.allDay.length, 0, "must not leak backward onto today");
  assert.deepEqual(dayStrips[0].allDay.map((c) => c.title), ["Payday"], "shows once, on its own day");
  assert.equal(dayStrips[1].allDay.length, 0, "must not leak forward past its own day");
});

test("an all-day item with no meta.end at all (defensive fallback) still matches its single start day", () => {
  const items = [ev({ id: "pd", title: "Payday", dueAt: THURS_STR, meta: { allDay: true } })];
  const { dayStrips } = buildDisplay({ items, config, now: NOW });
  assert.deepEqual(dayStrips[0].allDay.map((c) => c.title), ["Payday"]);
});

test("a multi-day all-day event appears on the Week page's badge for every day it spans", () => {
  const items = [ev({ id: "conf", title: "Conference", dueAt: TODAY_STR, meta: { allDay: true, end: FRIDAY_STR } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.deepEqual(d.week.days[0].allDay.map((c) => c.title), ["Conference"], "today");
  assert.deepEqual(d.week.days[1].allDay.map((c) => c.title), ["Conference"], "tomorrow");
  assert.equal(d.week.days[2].allDay.length, 0, "Friday is past the event's exclusive end date");
});

test("a multi-day all-day event appears in the 'next N days' text list on every day it spans, not just the first", () => {
  const items = [ev({ id: "conf", title: "Conference", dueAt: TODAY_STR, meta: { allDay: true, end: FRIDAY_STR } })];
  const d = buildDisplay({ items, config, now: NOW });
  assert.ok(d.days[0].items.some((i) => i.title === "Conference"), "tomorrow's day card");
});

console.log(`\n${passed} passed${process.exitCode ? ", WITH FAILURES" : ""}\n`);
