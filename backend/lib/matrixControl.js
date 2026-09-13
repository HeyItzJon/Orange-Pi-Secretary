// lib/matrixControl.js
//
// Live control for the ESP32 LED wall (Round 49 §6 of the Jarvis/voice/ESP
// roadmap — "live control of the ESP32 displays from the web page"). This
// is deliberately separate from /api/matrix's own DATA (portfolio numbers,
// events, headlines — refetched every ~30s): this file is CONTROL — which
// of those screens are in rotation right now, whether one is pinned, and a
// short-lived notification/"fun screen" to interrupt the rotation with.
// Tier 0 of that roadmap section: a second, tiny, fast-polled (1-2s) state
// blob, not a new protocol or service — see commandPayload() below.
//
// One state blob in `meta` (matrixControl), same mechanism moneySummary and
// stockIdea already use — nothing here is big or relational enough to earn
// its own table. Single physical display for now (the one ESP32-S3 + three
// chained panels from esp32-led-wall-handoff.md); nothing below assumes
// there's exactly one, there's just no per-device id yet because there's
// only one device to address.

import { getMeta, setMeta } from "./store.js";

const META_KEY = "matrixControl";

// The full catalog of screens the wall could show. `hasData: true` means
// /api/matrix already has real numbers behind it today — the firmware just
// needs a renderer. `false` means the idea is on record (so the toggle
// list shows what's coming, per Jon's "think of all the functionality I
// want" ask) without pretending it already works or forcing a second trip
// through this file once a real source — weather, say — gets built later.
export const SCREENS = [
  { id: "portfolio", label: "Portfolio", description: "Total value and today's change", hasData: true },
  { id: "markets", label: "Markets", description: "TSX / NASDAQ / S&P plus today's top movers", hasData: true },
  { id: "holdings", label: "Holdings", description: "Top 5 positions by value", hasData: true },
  { id: "events", label: "Today", description: "Today's calendar events and busy score", hasData: true },
  { id: "news", label: "News", description: "Latest market headlines", hasData: true },
  { id: "weather", label: "Weather", description: "No weather source is wired up yet — reserved for later", hasData: false },
];
const SCREEN_IDS = new Set(SCREENS.map((s) => s.id));
const DATA_SCREEN_IDS = new Set(SCREENS.filter((s) => s.hasData).map((s) => s.id));
const DEFAULT_ENABLED = SCREENS.filter((s) => s.hasData).map((s) => s.id);

// Round 75 — Jon: "we need to have every single screen possibility,
// including the extra ones... everything that we have in the LED panel
// code should be controllable from the website." These are the firmware's
// LOCAL_ONLY / ambient screens (esp32-led-wall.ino's own comment: "stars"/
// "balls" are ambient demo effects, not data screens") — they render from
// on-device state, not /api/matrix data, so they never belong in the
// rotation-membership toggle list above (there's nothing for the backend
// to enable/disable), but the firmware has always been willing to render
// any of them the moment pinnedScreen names one (loop() just does
// renderScreen(pinnedScreen, ...) with no allowlist check). The only thing
// missing was a way to reach them from the web page — this catalog is
// that: pin- and push-only, kept separate from SCREENS so the Screens
// section's checkboxes don't imply you can add these to auto-rotation.
export const BENCH_SCREENS = [
  { id: "clock", label: "Clock", description: "Large digital clock — no live data needed" },
  { id: "dayoverview", label: "Day Overview (bench)", description: "Hours busy/free for today, computed on-device" },
  { id: "commuting", label: "Commuting (bench)", description: "Commute ETA placeholder screen" },
  { id: "stars", label: "Stars", description: "Ambient starfield effect" },
  { id: "balls", label: "Balls", description: "Ambient bouncing-balls effect" },
];
const BENCH_IDS = new Set(BENCH_SCREENS.map((s) => s.id));
// Everything pin/push can legally target: the six data screens above plus
// the five bench-only ones. Deliberately does NOT require enabledScreens
// membership (see setPinnedScreen below) — pinning or pushing a screen
// already bypasses rotation entirely, so there was never a real reason to
// also demand it be in rotation, and bench screens could never be in
// rotation in the first place.
const ALL_PIN_IDS = new Set([...SCREEN_IDS, ...BENCH_IDS]);

// The wall is 192px wide (three 64px panels) at a small pixel font — a long
// notification just scrolls off into nothing useful. 60 chars is generous
// even so; firmware can always show less.
const MAX_NOTIFICATION_CHARS = 60;
const MIN_NOTIFICATION_SECONDS = 3;
const MAX_NOTIFICATION_SECONDS = 120;
const MAX_TEST_LABEL_CHARS = 40;

// Alerts get two wrapped lines across most of the panel width (see the
// firmware's renderAlert()/wrapTwoLines()), so they can run longer than a
// one-line notification.
const MAX_ALERT_CHARS = 80;
const MIN_ALERT_SECONDS = 5;
const MAX_ALERT_SECONDS = 300;
const ALERT_SEVERITIES = new Set(["low", "medium", "high"]);

// "Push a page" — Jon: "we can select pages, have them within the
// rotation, and then we can push a page or pin a page depending." Pin
// (setPinnedScreen, below) locks the wall on one screen indefinitely; push
// is the short-lived version — jump to a screen right now for a bit, then
// fall back to whatever pin/rotation was already active, without disturbing
// that state. Same expiresAt-recomputed-at-read pattern as notifications.
const MIN_PUSH_SECONDS = 5;
const MAX_PUSH_SECONDS = 120;
const DEFAULT_PUSH_SECONDS = 20;

export class MatrixControlError extends Error {}

function defaults() {
  return {
    enabledScreens: [...DEFAULT_ENABLED],
    pinnedScreen: null,
    pushedScreen: null,
    notification: null,
    alert: null,
    testEvent: null,
    lastPolledAt: null,
  };
}

// Merged over the defaults rather than returned as-is, so a field added
// here after Jon's first save (or a partial/corrupted blob) never comes
// back undefined to something downstream that assumes it's always there.
async function readRaw() {
  const saved = await getMeta(META_KEY, null);
  return { ...defaults(), ...(saved || {}) };
}

async function writeRaw(state) {
  await setMeta(META_KEY, state);
  return state;
}

// SCREENS' own order, filtered down to just the given ids — keeps rotation
// order stable and predictable regardless of the order toggles happened to
// be clicked in.
function sortToCanonical(ids) {
  const set = new Set(ids);
  return SCREENS.filter((s) => set.has(s.id)).map((s) => s.id);
}

export async function setEnabledScreens(ids) {
  if (!Array.isArray(ids)) throw new MatrixControlError("enabledScreens must be an array");
  const unknown = ids.filter((id) => !SCREEN_IDS.has(id));
  if (unknown.length) throw new MatrixControlError(`unknown screen(s): ${unknown.join(", ")}`);
  const noData = ids.filter((id) => !DATA_SCREEN_IDS.has(id));
  if (noData.length) throw new MatrixControlError(`these screens have no data source yet: ${noData.join(", ")}`);
  const cleaned = sortToCanonical(ids);
  if (!cleaned.length) throw new MatrixControlError("at least one screen must stay enabled");

  const state = await readRaw();
  state.enabledScreens = cleaned;
  // Round 75 — pin/push no longer require enabledScreens membership (see
  // setPinnedScreen below), so unchecking a screen's rotation box no
  // longer needs to clear an existing pin pointing at it — that pin is a
  // deliberate "show me this one regardless of rotation" choice, and bench
  // screens (never eligible for enabledScreens at all) need pins to survive
  // this call unconditionally anyway.
  return writeRaw(state);
}

export async function setPinnedScreen(id) {
  const state = await readRaw();
  if (id == null) {
    state.pinnedScreen = null;
    return writeRaw(state);
  }
  // Round 75 — Jon: "every single screen possibility... should be
  // controllable." Validated against the full pin-eligible universe (data
  // screens + bench-only ones) instead of just SCREEN_IDS, and no longer
  // requires the id be in enabledScreens: pinning already means "ignore
  // rotation and show this," so there was never a real reason to also
  // require rotation membership, and bench screens (clock, stars, ...)
  // could never be enabled in the first place, which made them permanently
  // unpinnable under the old rule.
  if (!ALL_PIN_IDS.has(id)) throw new MatrixControlError(`unknown screen: ${id}`);
  state.pinnedScreen = id;
  return writeRaw(state);
}

// Round 75 — the "push" half of "push a page or pin a page depending":
// jump to a screen right now for a short, bounded window, then fall back
// to whatever pin/rotation was already in effect, without touching that
// state. Same live-recomputed-at-read pattern as notifications (below) —
// nothing decays it on a timer, it's just judged expired the moment
// anyone reads state past its expiresAt.
export async function pushScreen(id, durationSeconds, now = new Date()) {
  if (!ALL_PIN_IDS.has(id)) throw new MatrixControlError(`unknown screen: ${id}`);
  const seconds = durationSeconds == null ? DEFAULT_PUSH_SECONDS : Math.round(Number(durationSeconds));
  if (!Number.isFinite(seconds)) throw new MatrixControlError("durationSeconds must be a number");
  const clamped = Math.min(MAX_PUSH_SECONDS, Math.max(MIN_PUSH_SECONDS, seconds));

  const state = await readRaw();
  state.pushedScreen = { id, expiresAt: new Date(now.getTime() + clamped * 1000).toISOString() };
  return writeRaw(state);
}

export async function clearPushedScreen() {
  const state = await readRaw();
  state.pushedScreen = null;
  return writeRaw(state);
}

export async function pushNotification(text, durationSeconds, now = new Date()) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new MatrixControlError("notification text can't be empty");
  if (trimmed.length > MAX_NOTIFICATION_CHARS) {
    throw new MatrixControlError(`keep it under ${MAX_NOTIFICATION_CHARS} characters — the wall is only 192px wide`);
  }
  const seconds = Math.round(Number(durationSeconds));
  if (!Number.isFinite(seconds)) throw new MatrixControlError("durationSeconds must be a number");
  const clamped = Math.min(MAX_NOTIFICATION_SECONDS, Math.max(MIN_NOTIFICATION_SECONDS, seconds));

  const state = await readRaw();
  state.notification = { text: trimmed, expiresAt: new Date(now.getTime() + clamped * 1000).toISOString() };
  return writeRaw(state);
}

export async function clearNotification() {
  const state = await readRaw();
  state.notification = null;
  return writeRaw(state);
}

// Round 75 — Jon: "the alert... everything that we have in the LED panel
// code should be controllable from the website." The firmware has fully
// implemented alert rendering since before this round (renderAlert(),
// AlertLevel severities, the hazard-stripe border) — see esp32-led-wall.ino
// pollCommand()'s own comment: "not sent by the backend at all yet...
// dormant until the backend adds it." This is the backend finally adding
// it, same push/clear/live-recompute shape as notifications above.
export async function pushAlert(text, severity, durationSeconds, now = new Date()) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new MatrixControlError("alert text can't be empty");
  if (trimmed.length > MAX_ALERT_CHARS) {
    throw new MatrixControlError(`keep it under ${MAX_ALERT_CHARS} characters`);
  }
  const sev = ALERT_SEVERITIES.has(severity) ? severity : "medium";
  const seconds = durationSeconds == null ? 30 : Math.round(Number(durationSeconds));
  if (!Number.isFinite(seconds)) throw new MatrixControlError("durationSeconds must be a number");
  const clamped = Math.min(MAX_ALERT_SECONDS, Math.max(MIN_ALERT_SECONDS, seconds));

  const state = await readRaw();
  state.alert = { text: trimmed, severity: sev, expiresAt: new Date(now.getTime() + clamped * 1000).toISOString() };
  return writeRaw(state);
}

export async function clearAlert() {
  const state = await readRaw();
  state.alert = null;
  return writeRaw(state);
}

// id counts up from whatever the last test event's id was, rather than
// Date.now() — two fires close together in a fast test (or a fast double
// click) could otherwise land on the same millisecond and look like no
// change happened at all.
export async function fireTestEvent(label) {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) throw new MatrixControlError("test event needs a label");
  const state = await readRaw();
  const nextId = (state.testEvent?.id ?? 0) + 1;
  state.testEvent = { id: nextId, label: trimmed.slice(0, MAX_TEST_LABEL_CHARS), firedAt: new Date().toISOString() };
  return writeRaw(state);
}

// Recomputed at read time rather than on a timer — nulled out the moment
// it's past its expiry regardless of who's asking, so it never outlives
// its own duration just because nothing happened to clear it in between.
function liveNotification(state, now) {
  if (!state.notification) return null;
  const msLeft = new Date(state.notification.expiresAt).getTime() - now.getTime();
  if (msLeft <= 0) return null;
  return { text: state.notification.text, secondsRemaining: Math.ceil(msLeft / 1000) };
}

function liveAlert(state, now) {
  if (!state.alert) return null;
  const msLeft = new Date(state.alert.expiresAt).getTime() - now.getTime();
  if (msLeft <= 0) return null;
  return { text: state.alert.text, severity: state.alert.severity, secondsRemaining: Math.ceil(msLeft / 1000) };
}

function livePushedScreen(state, now) {
  if (!state.pushedScreen) return null;
  const msLeft = new Date(state.pushedScreen.expiresAt).getTime() - now.getTime();
  if (msLeft <= 0) return null;
  return { id: state.pushedScreen.id, secondsRemaining: Math.ceil(msLeft / 1000) };
}

/**
 * What the ESP32 polls, fast (1-2s — Tier 0 of the roadmap). Just the
 * control signals, nothing it would need /api/matrix's full payload for.
 * Recording lastPolledAt here (not in statusPayload) means "last seen"
 * only ever reflects a real device checking in, never the web control
 * page glancing at its own state.
 */
export async function commandPayload(now = new Date()) {
  const state = await readRaw();
  state.lastPolledAt = now.toISOString();
  await writeRaw(state);
  return {
    enabledScreens: state.enabledScreens,
    pinnedScreen: state.pinnedScreen,
    pushedScreen: livePushedScreen(state, now),
    notification: liveNotification(state, now),
    alert: liveAlert(state, now),
    testEvent: state.testEvent ? { id: state.testEvent.id, label: state.testEvent.label } : null,
  };
}

/**
 * What the web control page reads — same signals, plus the bits only a
 * human needs: when the device last actually checked in (never fabricated
 * — `online` is false until a real poll has happened, not just because the
 * page loaded), and the full screen catalog so a `hasData: false` entry
 * added later shows up without a frontend deploy.
 */
export async function statusPayload(now = new Date(), { onlineWithinMs = 10_000 } = {}) {
  const state = await readRaw();
  const online = state.lastPolledAt != null && now.getTime() - new Date(state.lastPolledAt).getTime() < onlineWithinMs;
  return {
    screens: SCREENS,
    benchScreens: BENCH_SCREENS,
    enabledScreens: state.enabledScreens,
    pinnedScreen: state.pinnedScreen,
    pushedScreen: livePushedScreen(state, now),
    notification: liveNotification(state, now),
    alert: liveAlert(state, now),
    testEvent: state.testEvent,
    lastPolledAt: state.lastPolledAt,
    online,
  };
}
