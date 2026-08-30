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

// The wall is 192px wide (three 64px panels) at a small pixel font — a long
// notification just scrolls off into nothing useful. 60 chars is generous
// even so; firmware can always show less.
const MAX_NOTIFICATION_CHARS = 60;
const MIN_NOTIFICATION_SECONDS = 3;
const MAX_NOTIFICATION_SECONDS = 120;
const MAX_TEST_LABEL_CHARS = 40;

export class MatrixControlError extends Error {}

function defaults() {
  return { enabledScreens: [...DEFAULT_ENABLED], pinnedScreen: null, notification: null, testEvent: null, lastPolledAt: null };
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
  // A pin pointing at a screen that just got disabled would otherwise keep
  // showing it forever — clear it rather than leave a dangling reference
  // nothing in the UI still explains.
  if (state.pinnedScreen && !cleaned.includes(state.pinnedScreen)) state.pinnedScreen = null;
  return writeRaw(state);
}

export async function setPinnedScreen(id) {
  const state = await readRaw();
  if (id == null) {
    state.pinnedScreen = null;
    return writeRaw(state);
  }
  if (!SCREEN_IDS.has(id)) throw new MatrixControlError(`unknown screen: ${id}`);
  if (!state.enabledScreens.includes(id)) throw new MatrixControlError(`"${id}" isn't in the enabled rotation — enable it first`);
  state.pinnedScreen = id;
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
    notification: liveNotification(state, now),
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
    enabledScreens: state.enabledScreens,
    pinnedScreen: state.pinnedScreen,
    notification: liveNotification(state, now),
    testEvent: state.testEvent,
    lastPolledAt: state.lastPolledAt,
    online,
  };
}
