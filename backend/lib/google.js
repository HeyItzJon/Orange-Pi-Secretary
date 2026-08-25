// google.js
//
// Every Google call in one place. v1 duplicated getAccessToken() four times
// and fired 41 unthrottled requests at Gmail; this fixes both.
//
// API-budget decisions live here:
//   - the access token is cached in memory until ~1 min before it expires,
//     so a full run costs ONE token exchange instead of one per source
//   - Gmail messages are fetched with format=metadata and an explicit header
//     whitelist, not format=full — we only ever needed the headers, and this
//     is roughly an order of magnitude less data
//   - requests run through a small concurrency pool, not Promise.all
//   - the calendar list is cached to disk for a day; it changes ~never

import axios from "axios";
import { logger } from "./log.js";
import { getMeta, setMeta } from "./store.js";

const log = logger("google");
const TIMEOUT = 15000;

let tokenCache = { value: null, expiresAt: 0 };

export async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const { GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
  if (!GMAIL_REFRESH_TOKEN || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    throw new Error("Google credentials missing — .env needs GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN");
  }

  const res = await axios.post(
    "https://oauth2.googleapis.com/token",
    {
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    },
    { timeout: TIMEOUT }
  );

  const expiresIn = res.data.expires_in || 3600;
  tokenCache = { value: res.data.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
  log.debug("access token refreshed");
  return tokenCache.value;
}

/** Run tasks with bounded concurrency. Gentler on quota than Promise.all. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = null;
        log.warn(`task ${i} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(runners);
  return out;
}

async function authed(url, params, token) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: TIMEOUT,
  });
  return res.data;
}

// ----------------------------------------------------------------- Gmail

/** Just the ids. One cheap call; we filter against memory before fetching bodies. */
export async function listMessageIds({ query, maxResults = 40 }) {
  const token = await getAccessToken();
  const data = await authed(
    "https://www.googleapis.com/gmail/v1/users/me/messages",
    { q: query, maxResults },
    token
  );
  return (data.messages || []).map((m) => m.id);
}

const WANTED_HEADERS = ["From", "To", "Subject", "Date", "List-Unsubscribe", "Reply-To"];

/**
 * Headers + snippet only. This is all the classifier needs, and it keeps the
 * payload small enough that fetching 20 messages is genuinely cheap.
 */
export async function getMessagesMetadata(ids, { concurrency = 5 } = {}) {
  if (!ids.length) return [];
  const token = await getAccessToken();

  const results = await pool(ids, concurrency, async (id) => {
    const data = await authed(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${id}`,
      { format: "metadata", metadataHeaders: WANTED_HEADERS },
      token
    );
    const h = Object.fromEntries(
      (data.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value])
    );
    return {
      id: data.id,
      threadId: data.threadId,
      labelIds: data.labelIds || [],
      snippet: (data.snippet || "").trim(),
      from: h.from || "",
      to: h.to || "",
      subject: h.subject || "(no subject)",
      date: h.date || "",
      replyTo: h["reply-to"] || "",
      isNewsletter: Boolean(h["list-unsubscribe"]),
      internalDate: data.internalDate ? Number(data.internalDate) : null,
    };
  });

  return results.filter(Boolean);
}

// -------------------------------------------------------------- Calendar

/** Calendar list changes ~never, so cache it for a day and save a call per run. */
export async function getCalendarList({ ttlHours = 24, force = false } = {}) {
  const cached = await getMeta("calendarList");
  if (!force && cached && Date.now() - new Date(cached.at).getTime() < ttlHours * 3600000) {
    return cached.items;
  }

  const token = await getAccessToken();
  const data = await authed(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { minAccessRole: "reader", maxResults: 250 },
    token
  );
  const items = (data.items || []).map((c) => ({ id: c.id, summary: c.summary, color: c.backgroundColor || null }));
  await setMeta("calendarList", { at: new Date().toISOString(), items });
  log.info(`calendar list refreshed (${items.length} calendars)`);
  return items;
}

/**
 * Match configured names against what Google actually returns.
 *
 * v1 compared exact lowercased strings, which is why "Family Events"
 * never matched — Google returns a curly apostrophe (U+2019) and the config
 * had a straight one. Normalising quotes and whitespace fixes that class of
 * bug permanently.
 *
 * Exported because calendar-name matching turned out not to be a
 * resolveCalendars()-only problem: sources/calendar.js's reconciliation and
 * scripts/cleanup-orphaned-calendar-items.js both compare a stored item's
 * recorded calendar name against a fresh list from Google too, and hit the
 * exact same curly-quote class of bug — "Sydney's Demands" (an apostrophe
 * name if there ever was one) read as orphaned everywhere it was actually
 * still a real, unchanged calendar.
 */
export function normaliseName(s) {
  return String(s || "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function resolveCalendars(targetNames, { force = false } = {}) {
  const all = await getCalendarList({ force });
  const wanted = targetNames.map(normaliseName);
  const matched = all.filter((c) => wanted.includes(normaliseName(c.summary)));

  const missing = targetNames.filter(
    (name) => !matched.some((c) => normaliseName(c.summary) === normaliseName(name))
  );
  if (missing.length) {
    log.warn(`calendars not found: ${missing.join(", ")}`);
    log.warn(`available: ${all.map((c) => c.summary).join(" | ")}`);
  }
  return { matched, missing, available: all.map((c) => c.summary) };
}

export async function getEvents(calendars, { timeMin, timeMax, maxResults = 50 }) {
  const token = await getAccessToken();

  const chunks = await pool(calendars, 4, async (cal) => {
    const data = await authed(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`,
      {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults,
      },
      token
    );
    return (data.items || [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        id: e.id,
        calendarId: cal.id,
        calendarName: cal.summary,
        calendarColor: cal.color || null,
        summary: e.summary || "(no title)",
        description: e.description || "",
        location: e.location || "",
        htmlLink: e.htmlLink || "",
        allDay: Boolean(e.start?.date),
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        attendees: e.attendees?.length || 0,
        recurringEventId: e.recurringEventId || null,
        updated: e.updated || "",
      }));
  });

  // pool() swallows a per-calendar failure and leaves that slot null (see
  // pool() above) rather than throwing — one calendar's timeout must never
  // take the whole pull down. But a null slot is indistinguishable from "this
  // calendar genuinely has zero events right now" unless it's reported back:
  // collectCalendar() uses "an event that used to come back but didn't this
  // time" to detect a real deletion, and treating a failed fetch the same
  // way would read every event on that calendar as deleted.
  const failedCalendarIds = calendars.filter((cal, i) => chunks[i] === null).map((c) => c.id);

  return {
    events: chunks.filter(Boolean).flat().sort((a, b) => new Date(a.start) - new Date(b.start)),
    failedCalendarIds,
  };
}
