// lib/commute.js
//
// Round: commute/ETA feature (see claude/commute-eta-plan.md for the full
// design history). Computes `commuteMin` for the LED wall's Commuting
// screen (esp32-led-wall.ino's renderCommuting() has been waiting for this
// since round 57/72 — "no real ETA source wired up yet").
//
// Design, per Jon: "I can let the pi find out when I need to get to
// campus. only for the first campus event of the day is assumed to be a
// commute from home." So this never asks Jon to enumerate weekday/hour
// slots — it walks TODAY's real calendar events in order, tracking where
// he'd actually be (home, by default, until an event's location says
// otherwise), and only computes a drive when the next event is somewhere
// new. Two known "somewheres" are configured (home, Carleton, Richcraft);
// anything else with a location still gets a live one-off ETA rather than
// being silently skipped — never a fabricated one, per this project's
// hard rule (secretary-proposal.md: rules decide facts, AI only narrates).
//
// Cost discipline, same as eventDigest.js/newsDigest.js: this runs once
// per scheduler tick (via refreshCommute(), called through the normal
// source-collector pipeline — see brief/compose.js's collectCommute, folded
// in so a bad key or a spent quota shows up as a real lastError_commute in
// the dashboard's Sources panel ("Travel"), same as a dead Gmail token
// shows up for Email, rather than a silently stale number), NEVER inside
// the fast /api/matrix poll route, and only calls the Routes API at all
// when today's "next event needing a drive" actually changed since the
// last tick (cached by a content hash of that event's id+time).
//
// refreshCommute() used to swallow every failure internally (never threw,
// by design, back when scheduler.js called it standalone). Now that
// collectCommute() is the only caller and runSources() already gives every
// source that exact same per-source isolation (one source's exception
// never blocks the others — see compose.js's runSources), a genuine
// routing failure (bad key, spent quota, Routes API down) is allowed to
// throw here so it actually surfaces instead of only ever reaching a log
// line nobody's watching. "Nothing to compute right now" (not configured,
// nothing left today with a location, already there) is NOT an error and
// still just returns quietly — same distinction brightspace/weather draw
// between "off" and "broken."

import axios from "axios";
import { logger } from "./log.js";
import { allItems, getMeta, setMeta } from "./store.js";
import { cacheKey } from "./ids.js";

const log = logger("commute");

function todayKeyFor(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Which configured "known place" (if any) an event's raw location text
 * belongs to. Matching is deliberately dumb substring/case-insensitive —
 * these are Jon's own hand-typed calendar strings ("Carleton University P6
 * Parking...", "Richcraft Recreation Complex..."), not free-form addresses
 * that need geocoding to classify.
 */
export function classifyLocation(locationText, locations) {
  if (!locationText) return null;
  const lower = locationText.toLowerCase();
  for (const [key, loc] of Object.entries(locations || {})) {
    if ((loc.matchText || []).some((m) => lower.includes(String(m).toLowerCase()))) {
      return key;
    }
  }
  return null;
}

/**
 * Calls Google's Routes API once for a single origin/destination/departure
 * time, optionally avoiding highways. Returns duration in whole minutes,
 * or null on any failure (bad key, API not enabled, quota, network) — a
 * routing failure must degrade to "no commute info" like everywhere else
 * in this project, never to a guessed number.
 */
async function computeRoute({ originAddress, destinationAddress, departureTime, avoidHighways }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await axios.post(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        origin: { address: originAddress },
        destination: { address: destinationAddress },
        travelMode: "DRIVE",
        departureTime,
        routeModifiers: avoidHighways ? { avoidHighways: true } : undefined,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
        },
        timeout: 15000,
      }
    );
    const route = res.data?.routes?.[0];
    if (!route?.duration) return null;
    const seconds = parseInt(route.duration, 10);
    return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message;
    log.error(`Routes API call failed (${originAddress} -> ${destinationAddress}): ${reason}`);
    return null;
  }
}

/**
 * Picks the best (lowest) conservative estimate across a known place's
 * configured route variants — today just "default" vs "avoid highways",
 * both real Google routing preferences (see the doc's note on why a
 * literal "exit at Carling" variant isn't attempted: that needs a specific
 * ramp waypoint, which nobody's confirmed a real coordinate for yet — same
 * never-guess-a-location rule, applied to a route waypoint instead of a
 * destination).
 */
async function bestRouteMinutes({ originAddress, destinationAddress, departureTime, tryVariants, conservativeBufferPct }) {
  const attempts = tryVariants
    ? [
        { label: "fastest", avoidHighways: false },
        { label: "avoid-highway", avoidHighways: true },
      ]
    : [{ label: "fastest", avoidHighways: false }];

  const results = [];
  for (const a of attempts) {
    const minutes = await computeRoute({ originAddress, destinationAddress, departureTime, avoidHighways: a.avoidHighways });
    if (minutes != null) results.push({ label: a.label, minutes });
  }
  if (!results.length) return null;

  results.sort((a, b) => a.minutes - b.minutes);
  const best = results[0];
  const buffered = applyConservativeBuffer(best.minutes, conservativeBufferPct);
  return { minutes: buffered, route: best.label, rawMinutes: best.minutes };
}

/** Pure so it's easy to test on its own: round a raw drive time up by a
 * percentage, biasing every estimate pessimistic per Jon's "conservative"
 * requirement rather than trusting Google's raw prediction as-is. */
export function applyConservativeBuffer(minutes, pct) {
  return Math.ceil(minutes * (1 + (pct || 0) / 100));
}

/**
 * Called once per scheduler tick (via collectCommute, brief/compose.js).
 * Figures out whether the NEXT upcoming event with a resolved location
 * requires a drive (vs. "already there"), and if so, caches a real
 * commuteMin for /api/matrix to read. Throws on a genuine routing failure
 * (see the header comment above) — runSources() catches that and records
 * it as lastError_commute, same isolation every other source already gets.
 * "Nothing to compute right now" is not a failure and returns normally.
 */
export async function refreshCommute(config) {
  const cfg = config.commute;
  if (!cfg?.enabled || !cfg?.home?.address) {
    // Not configured yet — leave whatever's cached alone rather than
    // clobbering it with nothing; server.js only trusts today's entry.
    return;
  }

  const now = new Date();
  const today = todayKeyFor(config.timezone);
  const items = await allItems();
  const todaysEvents = items
    .filter((i) => i.source === "calendar" && !i.meta?.allDay && i.dueAt?.startsWith(today) && i.status === "open")
    .map((i) => ({ id: i.id, start: new Date(i.dueAt), location: i.meta?.location || null }))
    .sort((a, b) => a.start - b.start);

  // Walk today's events in order to find where Jon would actually be
  // right now: the location of the most recent event that has already
  // started, or "home" if none have yet (or none of today's past events
  // had a location at all — never assume you moved somewhere you can't
  // confirm from real data).
  let lastKnownKind = "home";
  for (const e of todaysEvents) {
    if (e.start > now) break;
    const kind = classifyLocation(e.location, cfg.locations);
    if (kind) lastKnownKind = kind;
  }

  const next = todaysEvents.find((e) => e.start > now && e.location);
  if (!next) {
    // Nothing left today with a location to drive to — same "unresolved,
    // never guessed" behavior as an event with no location at all.
    return;
  }

  const nextKind = classifyLocation(next.location, cfg.locations);

  // Already at the same kind of place as the next event (e.g. two
  // back-to-back Carleton classes) — no drive needed, just the flat
  // walk-across-campus buffer Jon gave us, not a routing call.
  if (nextKind && nextKind === lastKnownKind) {
    const key = cacheKey("commute-v1", { eventId: next.id, kind: "buffer" });
    const previous = await getMeta("commute", null);
    if (previous?.key === key) return; // nothing changed since last tick
    await setMeta("commute", {
      key,
      day: today,
      minutes: cfg.betweenEventsBufferMin ?? 10,
      route: null,
      label: "already there",
      eventId: next.id,
      computedAt: now.toISOString(),
    });
    log.info(`${next.id}: already at ${nextKind}, using ${cfg.betweenEventsBufferMin ?? 10}min buffer`);
    return;
  }

  // A real drive is needed. Skip the Routes API call entirely if nothing
  // about the target event has changed since the last successful compute
  // — this is what keeps a 20s-tick scheduler from burning API calls on
  // every tick for the same commute all morning.
  const key = cacheKey("commute-v1", { eventId: next.id, start: next.start.toISOString(), lastKnownKind });
  const previous = await getMeta("commute", null);
  if (previous?.key === key && previous?.day === today) return;

  const originAddress = lastKnownKind === "home" ? cfg.home.address : cfg.locations[lastKnownKind]?.address;
  const destLoc = nextKind ? cfg.locations[nextKind] : null;
  // Unknown place (not home/Carleton/Richcraft) still gets a real, live
  // one-off ETA using the event's own raw location text — never skipped,
  // never faked. Just no named route variants or arrival buffer, since
  // those are only defined for the known places.
  const destinationAddress = destLoc?.address || next.location;
  if (!originAddress || !destinationAddress) return;

  const result = await bestRouteMinutes({
    originAddress,
    destinationAddress,
    // Predictive traffic for roughly when this drive actually happens —
    // the event's own start time is used as the departure-time sample
    // (see commute-eta-plan.md: "close enough" for a commute-length
    // window; the conservative buffer below absorbs the residual error
    // rather than solving a full leave-by fixed point).
    departureTime: next.start.toISOString(),
    tryVariants: Boolean(destLoc?.routeVariants),
    conservativeBufferPct: cfg.conservativeBufferPct ?? 10,
  });
  if (!result) {
    // A genuine routing failure (bad key, spent quota, Routes API down, or
    // just no route exists) — thrown, not swallowed, so it reaches
    // collectCommute -> runSources and shows up as a real lastError_commute
    // ("Travel" in the Sources panel) instead of a silent log line.
    throw new Error(`no route found ${originAddress} -> ${destinationAddress} (check GOOGLE_MAPS_API_KEY / Routes API quota)`);
  }

  const arrivalBuffer = destLoc?.arrivalBufferMin ?? 0;
  await setMeta("commute", {
    key,
    day: today,
    minutes: result.minutes + arrivalBuffer,
    route: result.route,
    label: destLoc?.label || next.location,
    eventId: next.id,
    computedAt: now.toISOString(),
  });
  log.info(
    `${next.id}: ${originAddress} -> ${destinationAddress} = ${result.rawMinutes}min raw, ` +
      `${result.minutes}min buffered + ${arrivalBuffer}min arrival (route: ${result.route})`
  );
}
