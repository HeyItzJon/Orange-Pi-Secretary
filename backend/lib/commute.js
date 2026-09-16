// lib/commute.js
//
// Round: commute/ETA feature (see claude/commute-eta-plan.md for the full
// design history). Computes a full day's commute plan — every consecutive
// pair of today's located events, home included as the implicit start of
// the day — for the dashboard's Commute page, the daily total time/km/gas
// numbers, the DeepSeek insight line (lib/commuteTake.js), and the LED
// wall's Commuting screen (esp32-led-wall.ino's renderCommuting(), which
// only ever reads the single "next" leg — see the backward-compat section
// near the bottom of refreshCommute()).
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
// Buffers, per Jon's follow-up round: Carleton's `walkBufferMin` (10) is
// symmetric — "anywhere on campus to the parking lot is basically 10
// minutes... any time im leaving or arriving to the carleton parking lot I
// want that 10 min walking buffer" — applied whether Carleton is the
// ORIGIN (walk to the car before a drive can start) or the DESTINATION
// (walk from the car to class after a drive ends), and reused as the flat
// same-place buffer between two back-to-back Carleton events. Richcraft's
// `arrivalBufferMin` (5) is one-directional — "only on the way to richcraft
// from anywhere" — no buffer leaving work.
//
// Cost discipline, same as eventDigest.js/newsDigest.js: this runs once
// per scheduler tick (via refreshCommute(), called through the normal
// source-collector pipeline — see brief/compose.js's collectCommute, folded
// in so a bad key or a spent quota shows up as a real lastError_commute in
// the dashboard's Sources panel ("Travel"), same as a dead Gmail token
// shows up for Email, rather than a silently stale number), NEVER inside
// the fast /api/matrix poll route. Each leg is cached independently by a
// content hash of (origin kind, destination event id + start time), so a
// tick where nothing about the day's plan changed costs zero Routes API
// calls, and a change to one leg (a moved event, say) never forces every
// other already-resolved leg to recompute too.
//
// A genuine per-leg routing failure (bad key, spent quota, Routes API down)
// does not blank out the whole day's plan — the other legs still compute
// and are still shown — but IS collected and thrown once, at the end, so it
// still surfaces as a real lastError_commute ("Travel" in the Sources
// panel) exactly like every other source's failure does. "Nothing to
// compute right now" (not configured, no located events today) is not a
// failure and returns quietly — same distinction brightspace/weather draw
// between "off" and "broken."

import axios from "axios";
import { logger } from "./log.js";
import { allItems, getMeta, setMeta } from "./store.js";
import { cacheKey } from "./ids.js";
import { getCommuteInsight } from "./commuteTake.js";

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
 * The walk-to/from-the-car buffer for a place you're DRIVING AWAY FROM.
 * Only Carleton has one configured (walkBufferMin) — home needs none
 * (you're already at your door), and Richcraft's buffer is arrival-only
 * per Jon ("only on the way to richcraft from anywhere").
 */
export function departureBufferFor(cfg, kind) {
  if (!kind || kind === "home") return 0;
  return cfg?.locations?.[kind]?.walkBufferMin ?? 0;
}

/**
 * The walk-from-the-car buffer for a place you're DRIVING TO. Falls back
 * from arrivalBufferMin to walkBufferMin so a place like Carleton — which
 * only defines walkBufferMin, being symmetric — still gets an arrival
 * buffer without duplicating the number in config.
 */
export function arrivalBufferFor(cfg, kind) {
  if (!kind) return 0;
  const loc = cfg?.locations?.[kind];
  if (!loc) return 0;
  return loc.arrivalBufferMin ?? loc.walkBufferMin ?? 0;
}

/**
 * The flat, no-driving buffer between two back-to-back events at the SAME
 * known place (e.g. two Carleton classes) — a place's own walkBufferMin if
 * it has one, else the generic config-level fallback.
 */
export function sameLocationBufferFor(cfg, kind) {
  return cfg?.locations?.[kind]?.walkBufferMin ?? cfg?.betweenEventsBufferMin ?? 10;
}

/**
 * A plain, deterministic time-of-day rule — never a model guess. Returns
 * the matching window's label (e.g. "morning rush") if `date` (in `tz`)
 * falls inside one of config.commute.rushHours.windows, else null. Jon:
 * "rush hour is a big deal to me" — this is the real, decided fact
 * lib/commuteTake.js's AI line is allowed to react to; it never decides
 * for itself whether something is rush hour.
 */
export function isRushHour(date, cfg, tz) {
  const rh = cfg?.rushHours;
  if (!rh?.windows?.length) return null;

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "America/Toronto",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );

  if (rh.weekdayOnly && (parts.weekday === "Sat" || parts.weekday === "Sun")) return null;

  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  for (const w of rh.windows) {
    const [sh, sm] = String(w.start).split(":").map(Number);
    const [eh, em] = String(w.end).split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) continue;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (minutes >= startMin && minutes < endMin) return w.label || "rush hour";
  }
  return null;
}

/**
 * Calls Google's Routes API once for a single origin/destination/departure
 * time, optionally avoiding highways. Returns { minutes, km, reason }:
 * minutes/km are null on any failure (bad key, API not enabled, quota,
 * network, an address neither Google nor Jon's own calendar string could
 * be geocoded) — a routing failure must degrade to "no commute info" like
 * everywhere else in this project, never to a guessed number — and
 * `reason` carries Google's own error message (or the network-level one)
 * up to the caller, so a real failure ends up somewhere Jon can actually
 * read it (the thrown error in refreshCommute below, which becomes
 * lastError_commute / the dashboard's "Travel" row) instead of only ever
 * reaching a log line.
 */
async function computeRoute({ originAddress, destinationAddress, departureTime, avoidHighways }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return { minutes: null, km: null, reason: "no GOOGLE_MAPS_API_KEY set" };

  // Google rejects departureTime outright under the default TRAFFIC_UNAWARE
  // mode ("Timestamp cannot be set for TRAFFIC_UNAWARE routing mode" — hit
  // live, round: Travel source) AND rejects any departureTime that isn't
  // strictly in the future ("Timestamp must be set to a future time" — hit
  // live, round 92, once the full-day plan started computing legs for
  // events EARLIER today too, not just the next upcoming one). So a real
  // future drive gets predictive live-traffic routing (TRAFFIC_AWARE, the
  // cheaper of the two traffic-aware modes — see the cost note below), and
  // a leg whose event has already happened today gets a plain routingPreference,
  // no departureTime, since Google has no historical-traffic mode to ask
  // for anyway — this is the best honest estimate available for "how long
  // would that drive have taken," not a fabricated number. The 60s margin
  // absorbs the time between deciding "future" here and the request
  // actually reaching Google.
  const isFuture = departureTime && new Date(departureTime).getTime() > Date.now() + 60000;

  try {
    const res = await axios.post(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        origin: { address: originAddress },
        destination: { address: destinationAddress },
        travelMode: "DRIVE",
        ...(isFuture
          ? {
              departureTime,
              // TRAFFIC_AWARE_OPTIMAL trades latency for a bit more
              // accuracy, at the same billing tier — TRAFFIC_AWARE is
              // exactly what a predictive, time-of-day-aware ETA needs.
              // Real cost note, verified Sept 2026: this moves Compute
              // Routes calls from the Essentials SKU (10,000 free/month)
              // to the Pro SKU (5,000 free/month, then $10/1,000) — still
              // enormous headroom at Jon's real usage (a handful to a few
              // dozen calls/day), see claude/commute-eta-plan.md's
              // pricing section.
              routingPreference: "TRAFFIC_AWARE",
            }
          : { routingPreference: "TRAFFIC_UNAWARE" }),
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
    if (!route?.duration) return { minutes: null, km: null, reason: "Google returned no route (0 routes in the response)" };
    const seconds = parseInt(route.duration, 10);
    if (!Number.isFinite(seconds)) {
      return { minutes: null, km: null, reason: `unparseable duration in response: ${route.duration}` };
    }
    const km = Number.isFinite(route.distanceMeters) ? route.distanceMeters / 1000 : null;
    return { minutes: Math.round(seconds / 60), km, reason: null };
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message;
    log.error(`Routes API call failed (${originAddress} -> ${destinationAddress}): ${reason}`);
    return { minutes: null, km: null, reason };
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
  const failures = [];
  for (const a of attempts) {
    const { minutes, km, reason } = await computeRoute({ originAddress, destinationAddress, departureTime, avoidHighways: a.avoidHighways });
    if (minutes != null) results.push({ label: a.label, minutes, km });
    else failures.push(`${a.label}: ${reason}`);
  }
  // Every variant attempted failed — return the reasons instead of just
  // null, so the caller can build an error message that actually says WHY
  // (bad key, address not found, quota) instead of a generic "no route".
  if (!results.length) return { result: null, failures };

  results.sort((a, b) => a.minutes - b.minutes);
  const best = results[0];
  const buffered = applyConservativeBuffer(best.minutes, conservativeBufferPct);
  return { result: { minutes: buffered, rawMinutes: best.minutes, km: best.km, route: best.label }, failures: [] };
}

/** Pure so it's easy to test on its own: round a raw drive time up by a
 * percentage, biasing every estimate pessimistic per Jon's "conservative"
 * requirement rather than trusting Google's raw prediction as-is. */
export function applyConservativeBuffer(minutes, pct) {
  return Math.ceil(minutes * (1 + (pct || 0) / 100));
}

/**
 * One leg of the day: either a real drive (with buffers on whichever end
 * touches a place that has one) or a flat walking buffer when both ends
 * are the same known place. Returns null (never throws) when an address
 * can't be resolved at all — same "unresolved, never guessed" behavior an
 * event with no location gets — and throws only on a genuine routing
 * failure, which the caller (refreshCommute) collects rather than letting
 * kill the rest of the day's plan.
 *
 * toKind "home" is a synthetic third "known place" — refreshCommute's
 * implicit trailing "drive home" leg after the day's last located event
 * (round 92 follow-up: "there seems to be some of these missing" — the
 * plan used to just stop at the last event, never accounting for the real
 * drive back). It isn't in cfg.locations (home lives at cfg.home
 * separately), so it needs its own address/label resolution here rather
 * than falling through the destLoc lookup — arrivalBufferFor/
 * departureBufferFor already return 0 for it with no code change (neither
 * has a "home" entry in cfg.locations either), matching "no buffer walking
 * into your own house."
 */
async function computeLeg({ cfg, fromKind, toKind, toLocationText, departureTime, conservativeBufferPct }) {
  const destLoc = toKind && toKind !== "home" ? cfg.locations[toKind] : null;
  const label = toKind === "home" ? "Home" : destLoc?.label || toLocationText;

  // Already at the same kind of place as this event (e.g. two back-to-back
  // Carleton classes) — no drive needed, just the flat walk-across-campus
  // buffer Jon gave us, not a routing call.
  if (toKind && toKind === fromKind) {
    return { mode: "buffer", minutes: sameLocationBufferFor(cfg, toKind), km: 0, route: null, label: "already there" };
  }

  const originAddress = fromKind === "home" ? cfg.home.address : cfg.locations[fromKind]?.address;
  // Unknown place (not home/Carleton/Richcraft) still gets a real, live
  // one-off ETA using the event's own raw location text — never skipped,
  // never faked. Just no named route variants or buffers, since those are
  // only defined for the known places.
  const destinationAddress = toKind === "home" ? cfg.home.address : destLoc?.address || toLocationText;
  if (!originAddress || !destinationAddress) return null;

  const { result, failures } = await bestRouteMinutes({
    originAddress,
    destinationAddress,
    // Predictive traffic for roughly when this drive actually happens —
    // the event's own start time is used as the departure-time sample
    // (see commute-eta-plan.md: "close enough" for a commute-length
    // window; the conservative buffer below absorbs the residual error
    // rather than solving a full leave-by fixed point).
    departureTime,
    tryVariants: Boolean(destLoc?.routeVariants),
    conservativeBufferPct,
  });
  if (!result) {
    // A genuine routing failure (bad key, spent quota, Routes API down, an
    // address Google couldn't geocode) — thrown, not swallowed, so
    // refreshCommute can collect it and still surface it as a real
    // lastError_commute ("Travel" in the Sources panel) without letting it
    // blank out the rest of the day's already-resolved legs.
    throw new Error(`no route found ${originAddress} -> ${destinationAddress} (${failures.join("; ") || "unknown reason"})`);
  }

  const departureBuffer = departureBufferFor(cfg, fromKind);
  const arrivalBuffer = arrivalBufferFor(cfg, toKind);
  return {
    mode: "drive",
    minutes: result.minutes + departureBuffer + arrivalBuffer,
    driveMinutes: result.minutes,
    departureBufferMin: departureBuffer,
    arrivalBufferMin: arrivalBuffer,
    km: result.km,
    route: result.route,
    label,
  };
}

/**
 * Called once per scheduler tick (via collectCommute, brief/compose.js).
 * Builds the WHOLE day's commute plan — home, then every one of today's
 * located events in order, with a leg computed (or reused from cache)
 * between every consecutive pair — not just "the next" one. Caches the
 * full plan as `commutePlan` (what the dashboard's Commute page reads) and
 * derives the single "next upcoming leg" as `commute` (the legacy shape
 * the LED wall firmware's dov.commuteMin/hasCommute contract already
 * expects, unchanged). Throws once, at the end, if any leg's FRESH
 * computation this tick genuinely failed — runSources() catches that and
 * records it as lastError_commute, same isolation every other source
 * already gets. "Nothing to compute right now" (not configured, no located
 * events today) is not a failure and returns quietly.
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
    .map((i) => ({
      id: i.id,
      start: new Date(i.dueAt),
      // Real event end time, when Google gave one (sources/calendar.js
      // already stores it in meta.end for every calendar item — round 62
      // wired this up for the LED wall's Events screen). Used below for the
      // implicit trailing "drive home" leg's departure time; never
      // fabricated when it's missing.
      end: i.meta?.end ? new Date(i.meta.end) : null,
      title: i.title || "",
      location: i.meta?.location || null,
    }))
    .sort((a, b) => a.start - b.start);

  // Waypoints: an implicit "home" start-of-day, then every located event
  // in order. Events with no location don't change "where you are" and
  // aren't drive destinations (same rule the old single-leg version used),
  // so they're simply not waypoints — they still show up in the day's full
  // event list elsewhere (server.js's todayEvents), just without a leg.
  const located = todaysEvents
    .filter((e) => e.location)
    .map((e) => ({ ...e, kind: classifyLocation(e.location, cfg.locations) }));
  const waypoints = [{ id: "home", start: null }, ...located];

  if (located.length === 0) {
    // Nothing today with a location to route to at all — clear any stale
    // plan/next-leg from a previous day rather than leaving old data
    // sitting there looking current.
    await setMeta("commutePlan", null);
    await setMeta("commute", null);
    return;
  }

  // Round 92 follow-up, per Jon: "for the first and last carleton events of
  // the day, I expect ... the relevant drive time to or from my other
  // off-campus events. there seems to be some of these missing." The plan
  // used to stop at the day's last located event — there's a real drive
  // home after it too, same as the implicit "home" start-of-day waypoint
  // above. Only added when the last located event has a real END time to
  // depart from (see todaysEvents above); never guessed if it's missing.
  const lastLocated = located[located.length - 1];
  if (lastLocated.end) {
    waypoints.push({ id: "home-end", start: lastLocated.end, end: null, kind: "home", title: "Home", location: null });
  }

  const previousPlan = await getMeta("commutePlan", null);
  const previousLegs = previousPlan?.day === today ? previousPlan.legs || [] : [];
  const legByKey = new Map(previousLegs.map((l) => [l.key, l]));

  const legs = [];
  const freshFailures = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    const key = `${from.id}->${to.id}`;
    const fromKind = i === 0 ? "home" : from.kind;
    // A leg is only worth recomputing when something about it could have
    // actually changed: where you're coming from (fromKind), the target
    // event's own start time (a moved event), or — per Jon's round-92
    // follow-up ("if an event is ... changed ... make sure we ... reflect
    // that") — the target event's LOCATION. toKind covers a destination
    // reclassifying to/from a known place (e.g. its address text edited so
    // it no longer matches Carleton), and the raw toLocation text covers an
    // unclassified destination's address itself changing (its own text IS
    // the routed address in that case — see computeLeg's destinationAddress
    // fallback below). Any of these changing produces a different hash, so
    // the stale cached leg is never silently kept around pointing at the
    // wrong place. Unchanged, the cached result is reused untouched — this
    // is what keeps a 20s-tick scheduler from re-calling the Routes API for
    // the same day's plan all morning.
    const hash = cacheKey("leg-v3", {
      fromKind,
      toId: to.id,
      toStart: to.start.toISOString(),
      toKind: to.kind ?? null,
      toLocation: to.location ?? null,
    });

    const cached = legByKey.get(key);
    if (cached && cached.hash === hash) {
      legs.push(cached);
      continue;
    }

    try {
      const leg = await computeLeg({
        cfg,
        fromKind,
        toKind: to.kind,
        toLocationText: to.location,
        departureTime: to.start.toISOString(),
        conservativeBufferPct: cfg.conservativeBufferPct ?? 10,
      });
      if (!leg) continue; // unresolved origin/destination address — skip silently, same as before
      const withMeta = {
        key,
        hash,
        fromId: from.id,
        toId: to.id,
        toEventTitle: to.title,
        toStart: to.start.toISOString(),
        isRush: isRushHour(to.start, cfg, config.timezone),
        ...leg,
        computedAt: now.toISOString(),
      };
      legs.push(withMeta);
      log.info(`${key}: ${leg.mode} ${leg.minutes}min${leg.route ? ` (route: ${leg.route})` : ""}`);
    } catch (err) {
      freshFailures.push(`${key}: ${err.message}`);
      // Keep whatever was cached for this leg before, if anything, rather
      // than letting one bad recompute blank out a previously-good number
      // for the rest of the day.
      if (cached) legs.push(cached);
    }
  }

  // Round 92 follow-up, per Jon: "the walking doesnt count for drive time
  // and drive km ... lets only count the driving minutes and name the
  // total drive time (since I dont walk anywhere important)." So the
  // headline daily number is the sum of each drive leg's OWN driveMinutes
  // (the real Routes API estimate, conservative-padded — never including
  // the walk-to/from-the-car buffers baked into that leg's full `minutes`),
  // and walk-only "buffer" legs (mode: "buffer" — two back-to-back events
  // at the same place) don't contribute at all. totalKm was already
  // drive-only (a buffer leg's km is always 0), so it needs no change.
  const totalDriveMinutes = legs.reduce((sum, l) => (l.mode === "drive" ? sum + (l.driveMinutes || 0) : sum), 0);
  const totalKm = legs.reduce((sum, l) => sum + (l.km || 0), 0);
  const vehicle = cfg.vehicle || {};
  const fuelCostCAD =
    vehicle.fuelLPer100km != null && vehicle.pricePerLiterCAD != null
      ? Math.round(totalKm * (vehicle.fuelLPer100km / 100) * vehicle.pricePerLiterCAD * 100) / 100
      : null;

  const plan = {
    day: today,
    legs,
    totalDriveMinutes: Math.round(totalDriveMinutes),
    totalKm: Math.round(totalKm * 10) / 10,
    fuelCostCAD,
    generatedAt: now.toISOString(),
  };

  // One DeepSeek line reacting to the day's already-decided facts (rush
  // hour, real minutes, real totals) — never gating the real numbers
  // above, which are already written regardless of whether this succeeds.
  const insight = await getCommuteInsight(config, plan, { previous: previousPlan });
  plan.insight = insight?.text ?? (previousPlan?.day === today ? previousPlan.insight : null) ?? null;
  plan.insightAt = insight?.at ?? (previousPlan?.day === today ? previousPlan.insightAt : null) ?? null;

  await setMeta("commutePlan", plan);

  // Backward-compat: the LED wall firmware only ever reads a single "next"
  // leg (dov.commuteMin/hasCommute — esp32-led-wall.ino's renderCommuting()
  // predates this round's full-day plan). Derived from the plan above
  // rather than computed separately, so it's never a second, possibly-
  // disagreeing source of truth for the same leg. Round 92 follow-up, per
  // Jon: "the walking doesnt need to be specified its more the driving legs
  // I want a leave by" — a walk-only buffer leg was never really an ETA to
  // begin with (no route, no km), so "next" only ever considers a real
  // drive now, same distinction the daily totals above make.
  const nextDriveLeg = legs.find((l) => l.mode === "drive" && new Date(l.toStart) > now);
  await setMeta(
    "commute",
    nextDriveLeg
      ? {
          day: today,
          minutes: nextDriveLeg.minutes,
          route: nextDriveLeg.route,
          label: nextDriveLeg.label,
          eventId: nextDriveLeg.toId,
          // The leg's own target time (its "leave by" is this minus
          // minutes) — added so the dashboard can compute a leave-by
          // without needing a matching events[] entry, since the target can
          // now be the synthetic "drive home" leg above, which isn't a real
          // calendar event.
          targetAt: nextDriveLeg.toStart,
          computedAt: nextDriveLeg.computedAt,
        }
      : null
  );

  if (freshFailures.length) {
    throw new Error(`${freshFailures.length} leg(s) failed: ${freshFailures.join("; ")}`);
  }
}
