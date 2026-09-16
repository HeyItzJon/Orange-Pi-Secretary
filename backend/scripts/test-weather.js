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
group("buildWeatherFacts — assembling one Open-Meteo response into facts");

test("a typical clear, mild response", () => {
  const payload = {
    current: { time: "2026-09-15T13:00", temperature_2m: 21.4, weather_code: 0 },
    daily: { temperature_2m_max: [24.1], temperature_2m_min: [12.3], weather_code: [0] },
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
});

test("a cold day with afternoon snow flags icy roads", () => {
  const payload = {
    current: { time: "2026-09-15T09:00", temperature_2m: -3, weather_code: 3 },
    daily: { temperature_2m_max: [-1], temperature_2m_min: [-8], weather_code: [73] },
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

test("missing fields degrade to nulls rather than throwing", () => {
  const facts = buildWeatherFacts({});
  assert.equal(facts.currentTempC, null);
  assert.equal(facts.highC, null);
  assert.equal(facts.lowC, null);
  assert.equal(facts.conditionKey, "cloud"); // code defaults to 3 (overcast) when nothing is sent
  assert.deepEqual(facts.hourlySlots, []);
});

// ====================================================================
group("buildFallbackSummary — the no-AI sentence, in Jon's example register");

test("hot clear day, no precipitation", () => {
  const facts = { conditionKey: "sun", conditionLabel: "clear", highC: 31, lowC: 20, precipWindow: null, icyRoadRisk: false };
  assert.equal(buildFallbackSummary(facts), "A hot day, high of 31°C. Clear skies.");
});

test("mild day with afternoon rain", () => {
  const facts = {
    conditionKey: "rain", conditionLabel: "rain", highC: 15, lowC: 9,
    precipWindow: { probabilityPercent: 70, periodLabel: "this afternoon", kind: "rain" },
    icyRoadRisk: false,
  };
  assert.equal(buildFallbackSummary(facts), "A mild day, high of 15°C. 70% chance of rain this afternoon.");
});

test("very cold day with icy roads called out", () => {
  const facts = {
    conditionKey: "snow", conditionLabel: "snow", highC: -12, lowC: -18,
    precipWindow: { probabilityPercent: 40, periodLabel: "this evening", kind: "snow" },
    icyRoadRisk: true,
  };
  assert.equal(
    buildFallbackSummary(facts),
    "A very cold day, high of -12°C. 40% chance of snow this evening. Icy roads possible."
  );
});

test("no high/low at all falls back to the condition label alone", () => {
  const facts = { conditionKey: "cloud", conditionLabel: "foggy", highC: null, lowC: null, precipWindow: null, icyRoadRisk: false };
  assert.equal(buildFallbackSummary(facts), "Foggy today.");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
