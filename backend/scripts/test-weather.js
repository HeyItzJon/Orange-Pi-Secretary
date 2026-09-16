// scripts/test-weather.js — the pure rule math behind the Weather screen
// (icon bucketing, the precipitation-window pick, the icy-road rule, and
// the no-AI fallback sentence). No network calls here; the real Open-Meteo
// fetch and the DeepSeek description (collectWeather / getWeatherSummary)
// are exercised manually against real data instead, same convention
// scripts/test-market-news.js already uses for its own network half.
//
// Run: node scripts/test-weather.js

import assert from "node:assert/strict";
import {
  iconForWmoCode,
  conditionLabelForWmoCode,
  buildPrecipWindow,
  computeIcyRoadRisk,
  buildWeatherFacts,
  buildFallbackSummary,
  buildHourlySlots,
  peakHeatSlot,
  compareToYesterday,
  buildTodaysEvents,
} from "../sources/weather.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

// ====================================================================
group("iconForWmoCode — the six wall glyph buckets");

test("0 is sun, 1/2 are partly sunny, 3/45/48 are cloud", () => {
  assert.equal(iconForWmoCode(0), "sun");
  assert.equal(iconForWmoCode(1), "partly_sunny");
  assert.equal(iconForWmoCode(2), "partly_sunny");
  assert.equal(iconForWmoCode(3), "cloud");
  assert.equal(iconForWmoCode(45), "cloud");
  assert.equal(iconForWmoCode(48), "cloud");
});

test("drizzle/rain/rain-shower codes all bucket to rain", () => {
  for (const code of [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]) {
    assert.equal(iconForWmoCode(code), "rain", `code ${code}`);
  }
});

test("snow/snow-shower codes bucket to snow", () => {
  for (const code of [71, 73, 75, 77, 85, 86]) {
    assert.equal(iconForWmoCode(code), "snow", `code ${code}`);
  }
});

test("thunderstorm codes bucket to lightning", () => {
  for (const code of [95, 96, 99]) assert.equal(iconForWmoCode(code), "lightning", `code ${code}`);
});

test("an unrecognized code falls back to cloud rather than throwing", () => {
  assert.equal(iconForWmoCode(1234), "cloud");
});

// ====================================================================
group("conditionLabelForWmoCode");

test("known codes get a human label", () => {
  assert.equal(conditionLabelForWmoCode(0), "clear");
  assert.equal(conditionLabelForWmoCode(61), "light rain");
  assert.equal(conditionLabelForWmoCode(95), "thunderstorms");
});

test("an unknown code degrades to a generic label, not undefined", () => {
  assert.equal(conditionLabelForWmoCode(1234), "mixed conditions");
});

// ====================================================================
group("buildPrecipWindow — picks the peak hour remaining today, bucketed");

test("picks the highest-probability remaining hour and labels its period", () => {
  const hourly = {
    time: ["2026-09-15T09:00", "2026-09-15T14:00", "2026-09-15T20:00"],
    precipitation_probability: [10, 70, 40],
    weather_code: [3, 61, 61],
  };
  const w = buildPrecipWindow(hourly, { fromHour: 0 });
  assert.deepEqual(w, { probabilityPercent: 70, periodLabel: "this afternoon", kind: "rain" });
});

test("ignores hours already in the past (fromHour)", () => {
  const hourly = {
    time: ["2026-09-15T09:00", "2026-09-15T14:00"],
    precipitation_probability: [90, 40],
    weather_code: [61, 61],
  };
  // it's 1pm — the 90% morning hour has already happened
  const w = buildPrecipWindow(hourly, { fromHour: 13 });
  assert.deepEqual(w, { probabilityPercent: 40, periodLabel: "this afternoon", kind: "rain" });
});

test("a snow code at the peak hour reports kind 'snow'", () => {
  const hourly = {
    time: ["2026-09-15T22:00"],
    precipitation_probability: [80],
    weather_code: [73],
  };
  const w = buildPrecipWindow(hourly, { fromHour: 0 });
  assert.equal(w.kind, "snow");
  assert.equal(w.periodLabel, "overnight");
});

test("below the threshold (default 30%) returns null rather than a weak callout", () => {
  const hourly = { time: ["2026-09-15T14:00"], precipitation_probability: [20], weather_code: [61] };
  assert.equal(buildPrecipWindow(hourly, { fromHour: 0 }), null);
});

test("missing/empty hourly data returns null without throwing", () => {
  assert.equal(buildPrecipWindow(null), null);
  assert.equal(buildPrecipWindow({ time: [] }), null);
});

// ====================================================================
group("computeIcyRoadRisk — a plain threshold, not a model guess");

test("cold + a precip window today => risk", () => {
  const precipWindow = { probabilityPercent: 60, periodLabel: "this evening", kind: "rain" };
  assert.equal(computeIcyRoadRisk({ lowC: -2, precipWindow, conditionKey: "rain" }), true);
});

test("cold + snow condition even with no precip window pick => risk", () => {
  assert.equal(computeIcyRoadRisk({ lowC: 0, precipWindow: null, conditionKey: "snow" }), true);
});

test("cold with no precipitation at all => no risk", () => {
  assert.equal(computeIcyRoadRisk({ lowC: -5, precipWindow: null, conditionKey: "sun" }), false);
});

test("mild temperature with rain => no risk (not cold enough to freeze)", () => {
  const precipWindow = { probabilityPercent: 80, periodLabel: "this afternoon", kind: "rain" };
  assert.equal(computeIcyRoadRisk({ lowC: 8, precipWindow, conditionKey: "rain" }), false);
});

test("a missing low temperature never risks a false positive", () => {
  assert.equal(computeIcyRoadRisk({ lowC: null, precipWindow: null, conditionKey: "rain" }), false);
});

// ====================================================================
group("buildHourlySlots — round 86, the hourly timeline bar's real data");

function hourlyFixture(hours, { withTemp = true } = {}) {
  const time = hours.map((h) => `2026-09-15T${String(h).padStart(2, "0")}:00`);
  const weather_code = hours.map(() => 0);
  const precipitation_probability = hours.map(() => 0);
  const fixture = { time, weather_code, precipitation_probability };
  if (withTemp) fixture.temperature_2m = hours.map((h) => 10 + h);
  return fixture;
}

test("buckets a full day into one slot per hour across the fixed 6am-10pm window", () => {
  const hourly = hourlyFixture(Array.from({ length: 24 }, (_, h) => h));
  const slots = buildHourlySlots(hourly);
  assert.equal(slots.length, 17); // 6..22 inclusive
  assert.equal(slots[0].hour, 6);
  assert.equal(slots[slots.length - 1].hour, 22);
});

test("each slot carries an hour label, temp, icon, and precip probability", () => {
  const hourly = hourlyFixture([6, 7, 8]);
  hourly.weather_code = [0, 61, 73];
  hourly.precipitation_probability = [0, 80, 40];
  const slots = buildHourlySlots(hourly, { startHour: 6, endHour: 8 });
  assert.deepEqual(slots[0], { hour: 6, hourLabel: "6 AM", tempC: 16, icon: "sun", pop: 0 });
  assert.deepEqual(slots[1], { hour: 7, hourLabel: "7 AM", tempC: 17, icon: "rain", pop: 80 });
  assert.deepEqual(slots[2], { hour: 8, hourLabel: "8 AM", tempC: 18, icon: "snow", pop: 40 });
});

test("hour labels cross noon and midnight correctly (12 AM / 12 PM, not 0/24)", () => {
  const hourly = hourlyFixture([0, 12, 23]);
  const slots = buildHourlySlots(hourly, { startHour: 0, endHour: 23 });
  assert.equal(slots.find((s) => s.hour === 0).hourLabel, "12 AM");
  assert.equal(slots.find((s) => s.hour === 12).hourLabel, "12 PM");
  assert.equal(slots.find((s) => s.hour === 23).hourLabel, "11 PM");
});

test("a missing temperature_2m array degrades slots to a null tempC rather than throwing", () => {
  const hourly = hourlyFixture([6, 7], { withTemp: false });
  const slots = buildHourlySlots(hourly, { startHour: 6, endHour: 7 });
  assert.equal(slots[0].tempC, null);
  assert.equal(slots[1].tempC, null);
});

test("missing/empty hourly data returns [] without throwing", () => {
  assert.deepEqual(buildHourlySlots(null), []);
  assert.deepEqual(buildHourlySlots({ time: [] }), []);
});

test("a custom window narrows or widens which hours come back", () => {
  const hourly = hourlyFixture(Array.from({ length: 24 }, (_, h) => h));
  const slots = buildHourlySlots(hourly, { startHour: 9, endHour: 11 });
  assert.deepEqual(slots.map((s) => s.hour), [9, 10, 11]);
});

// ====================================================================
group("peakHeatSlot — round 87, the hottest hour left for the summary line");

test("picks the hottest slot, not just the last one", () => {
  const slots = [
    { hour: 6, hourLabel: "6 AM", tempC: 10, icon: "cloud", pop: 0 },
    { hour: 15, hourLabel: "3 PM", tempC: 22, icon: "sun", pop: 0 },
    { hour: 20, hourLabel: "8 PM", tempC: 16, icon: "cloud", pop: 0 },
  ];
  assert.deepEqual(peakHeatSlot(slots), { hourLabel: "3 PM", tempC: 22 });
});

test("skips slots with no temperature rather than treating null as the max", () => {
  const slots = [
    { hour: 6, hourLabel: "6 AM", tempC: null, icon: "cloud", pop: 0 },
    { hour: 15, hourLabel: "3 PM", tempC: 19, icon: "sun", pop: 0 },
  ];
  assert.deepEqual(peakHeatSlot(slots), { hourLabel: "3 PM", tempC: 19 });
});

test("no slots, or none with a temperature, returns null", () => {
  assert.equal(peakHeatSlot([]), null);
  assert.equal(peakHeatSlot(null), null);
  assert.equal(peakHeatSlot([{ hour: 6, hourLabel: "6 AM", tempC: null, icon: "cloud", pop: 0 }]), null);
});

// ====================================================================
group("compareToYesterday — a fixed °C-delta rule, not a model guess");

test("a big jump either way is 'much warmer'/'much colder'", () => {
  assert.equal(compareToYesterday(28, 18), "much warmer");
  assert.equal(compareToYesterday(10, 22), "much colder");
});

test("a moderate difference is plain 'warmer'/'colder'", () => {
  assert.equal(compareToYesterday(20, 16), "warmer");
  assert.equal(compareToYesterday(16, 20), "colder");
});

test("within 3°C either way reads as 'about the same'", () => {
  assert.equal(compareToYesterday(20, 19), "about the same");
  assert.equal(compareToYesterday(20, 22), "about the same");
});

test("missing either temperature returns null rather than a false comparison", () => {
  assert.equal(compareToYesterday(null, 20), null);
  assert.equal(compareToYesterday(20, null), null);
});

// ====================================================================
group("buildTodaysEvents — round 87, today's remaining events for the AI prompt's sweater joke");

const TZ = "America/Toronto";
function item(o) {
  return { source: "calendar", kind: "upcoming", title: "Event", dueAt: null, meta: {}, ...o };
}

test("keeps only today's still-upcoming timed calendar events, sorted by time", () => {
  const now = new Date("2026-09-15T16:00:00Z"); // noon Toronto (EDT)
  const items = [
    item({ title: "Soccer", dueAt: "2026-09-15T21:00:00Z" }), // 5pm Toronto — later today
    item({ title: "Already happened", dueAt: "2026-09-15T13:00:00Z" }), // 9am Toronto — earlier today
    item({ title: "Lunch", dueAt: "2026-09-15T17:00:00Z" }), // 1pm Toronto — later today
  ];
  const events = buildTodaysEvents(items, { tz: TZ, now });
  assert.deepEqual(events.map((e) => e.title), ["Lunch", "Soccer"]);
  assert.equal(events[0].time, "1:00 PM");
  assert.equal(events[1].time, "5:00 PM");
});

test("excludes tomorrow's events, all-day events, and non-calendar items", () => {
  const now = new Date("2026-09-15T16:00:00Z");
  const items = [
    item({ title: "Tomorrow", dueAt: "2026-09-16T21:00:00Z" }),
    item({ title: "All-day", dueAt: "2026-09-15T21:00:00Z", meta: { allDay: true } }),
    item({ source: "email", title: "Not an event", dueAt: "2026-09-15T21:00:00Z" }),
  ];
  assert.deepEqual(buildTodaysEvents(items, { tz: TZ, now }), []);
});

test("caps the list at `max` events", () => {
  const now = new Date("2026-09-15T16:00:00Z");
  const items = Array.from({ length: 8 }, (_, i) =>
    item({ title: `Event ${i}`, dueAt: `2026-09-15T${18 + i}:00:00Z` })
  );
  assert.equal(buildTodaysEvents(items, { tz: TZ, now, max: 3 }).length, 3);
});

test("no items, or nothing left today, returns []", () => {
  assert.deepEqual(buildTodaysEvents([], { tz: TZ }), []);
  assert.deepEqual(buildTodaysEvents(null, { tz: TZ }), []);
});

// ====================================================================
group("buildWeatherFacts — assembling one Open-Meteo response into facts");

test("a typical clear, mild response", () => {
  const payload = {
    current: { time: "2026-09-15T13:00", temperature_2m: 21.4, weather_code: 0 },
    daily: { time: ["2026-09-15"], temperature_2m_max: [24.1], temperature_2m_min: [12.3], weather_code: [0] },
    hourly: { time: ["2026-09-15T13:00"], precipitation_probability: [0], weather_code: [0] },
  };
  const facts = buildWeatherFacts(payload);
  assert.equal(facts.conditionKey, "sun");
  assert.equal(facts.conditionLabel, "clear");
  assert.equal(facts.currentTempC, 21);
  assert.equal(facts.highC, 24);
  assert.equal(facts.lowC, 12);
  assert.equal(facts.precipWindow, null);
  assert.equal(facts.icyRoadRisk, false);
  assert.equal(facts.hourlySlots.length, 1);
  assert.equal(facts.hourlySlots[0].icon, "sun");
  // no daily.time entry before today's => no yesterday to compare against
  assert.equal(facts.yesterdayHighC, null);
  assert.equal(facts.vsYesterday, null);
});

test("a cold day with afternoon snow flags icy roads", () => {
  const payload = {
    current: { time: "2026-09-15T09:00", temperature_2m: -3, weather_code: 3 },
    daily: { time: ["2026-09-15"], temperature_2m_max: [-1], temperature_2m_min: [-8], weather_code: [73] },
    hourly: {
      time: ["2026-09-15T09:00", "2026-09-15T15:00"],
      precipitation_probability: [10, 75],
      weather_code: [3, 73],
    },
  };
  const facts = buildWeatherFacts(payload);
  assert.equal(facts.highC, -1);
  assert.equal(facts.lowC, -8);
  assert.deepEqual(facts.precipWindow, { probabilityPercent: 75, periodLabel: "this afternoon", kind: "snow" });
  assert.equal(facts.icyRoadRisk, true);
});

test("round 87 — past_days=1 gives daily/hourly two days; today is found by date, not index 0", () => {
  const payload = {
    current: { time: "2026-09-15T14:00", temperature_2m: 8, weather_code: 3 },
    daily: {
      time: ["2026-09-14", "2026-09-15"],
      temperature_2m_max: [22, 9], // yesterday was much warmer
      temperature_2m_min: [10, 2],
      weather_code: [0, 3],
    },
    hourly: {
      // yesterday's hours share the same hour-of-day as today's — this is
      // exactly the collision buildHourlySlots'/buildPrecipWindow's dateKey
      // filtering has to resolve correctly.
      time: ["2026-09-14T09:00", "2026-09-14T14:00", "2026-09-15T09:00", "2026-09-15T14:00"],
      temperature_2m: [24, 25, 7, 9],
      precipitation_probability: [0, 0, 10, 15],
      weather_code: [0, 0, 3, 3],
    },
  };
  const facts = buildWeatherFacts(payload);
  assert.equal(facts.highC, 9, "today's high, not yesterday's");
  assert.equal(facts.lowC, 2);
  assert.equal(facts.yesterdayHighC, 22);
  assert.equal(facts.vsYesterday, "much colder");
  // only today's 2 hours should show up, not yesterday's 2
  assert.equal(facts.hourlySlots.filter((s) => s.tempC != null).length, 2);
  assert.deepEqual(
    facts.hourlySlots.filter((s) => s.tempC != null).map((s) => s.tempC),
    [7, 9]
  );
});

test("missing fields degrade to nulls rather than throwing", () => {
  const facts = buildWeatherFacts({});
  assert.equal(facts.currentTempC, null);
  assert.equal(facts.highC, null);
  assert.equal(facts.lowC, null);
  assert.equal(facts.conditionKey, "cloud"); // code defaults to 3 (overcast) when nothing is sent
  assert.deepEqual(facts.hourlySlots, []);
  assert.equal(facts.yesterdayHighC, null);
  assert.equal(facts.vsYesterday, null);
  assert.equal(facts.peakHeat, null);
});

// ====================================================================
group("buildFallbackSummary — the no-AI sentence — round 87: never restates the high/low");

test("a plain day with nothing notable just states the condition", () => {
  const facts = { conditionKey: "sun", conditionLabel: "clear", highC: 31, lowC: 20, precipWindow: null, icyRoadRisk: false };
  assert.equal(buildFallbackSummary(facts), "Clear today.");
});

test("mild day with afternoon rain — never says 'high of 15°C'", () => {
  const facts = {
    conditionKey: "rain", conditionLabel: "rain", highC: 15, lowC: 9,
    precipWindow: { probabilityPercent: 70, periodLabel: "this afternoon", kind: "rain" },
    icyRoadRisk: false,
  };
  const summary = buildFallbackSummary(facts);
  assert.equal(summary, "Rain today. 70% chance of rain this afternoon.");
  assert.ok(!summary.includes("15"), "must not restate the high");
});

test("very cold day with icy roads called out", () => {
  const facts = {
    conditionKey: "snow", conditionLabel: "snow", highC: -12, lowC: -18,
    precipWindow: { probabilityPercent: 40, periodLabel: "this evening", kind: "snow" },
    icyRoadRisk: true,
  };
  assert.equal(
    buildFallbackSummary(facts),
    "Snow today. 40% chance of snow this evening. Icy roads possible."
  );
});

test("a notable vsYesterday is mentioned; 'about the same' is not", () => {
  const colder = { conditionKey: "cloud", conditionLabel: "overcast", precipWindow: null, icyRoadRisk: false, vsYesterday: "much colder" };
  assert.equal(buildFallbackSummary(colder), "Overcast today. Much colder than yesterday.");

  const same = { conditionKey: "cloud", conditionLabel: "overcast", precipWindow: null, icyRoadRisk: false, vsYesterday: "about the same" };
  assert.equal(buildFallbackSummary(same), "Overcast today.");
});

test("falls back to peak heat when there's no notable vsYesterday", () => {
  const facts = {
    conditionKey: "sun", conditionLabel: "clear", precipWindow: null, icyRoadRisk: false,
    vsYesterday: null, peakHeat: { hourLabel: "3 PM", tempC: 24 },
  };
  assert.equal(buildFallbackSummary(facts), "Clear today. Peak heat around 3 PM.");
});

test("no high/low at all falls back to the condition label alone", () => {
  const facts = { conditionKey: "cloud", conditionLabel: "foggy", highC: null, lowC: null, precipWindow: null, icyRoadRisk: false };
  assert.equal(buildFallbackSummary(facts), "Foggy today.");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
