// lib/sources.js
//
// One list, imported everywhere. This used to be a literal
// ["email","calendar","money","notes"] copy-pasted into four files, and they
// drifted: the scheduler was calling a "news" source that no longer existed,
// so every quarter-hour it recorded an "unknown source" error against a name
// nothing else knew about.

// "vault" was removed as a task/event source: the secretary now only reads
// the vault for holdings (money.js talks to it directly), never for
// checkboxes or loose-thread prose. The vault is life context you keep, not
// something this pipeline tries to understand.
//
// "brightspace" is off by default in practice, not in code — it's always on
// this list and always polled on the same clock as everything else, but
// sources/brightspace.js itself no-ops cleanly (0 items, no error) until
// BRIGHTSPACE_ICS_URL is actually set in .env. See that file's own header.
//
// "marketNews" needs no credential at all (free RSS + the same Yahoo
// Finance library the price pulls already use) — always on, same as money.
//
// "weather" (round 82) needs no credential either — Open-Meteo is free and
// keyless — always on, same reasoning.
//
// "commute" (commute/ETA feature) is the same shape again: always on this
// list, and its own collector (brief/compose.js's collectCommute) no-ops
// cleanly (0 items, no error) whenever config.commute.enabled is false or
// there's simply nothing to route to right now — same "off in practice,
// not in code" posture as brightspace. A genuine routing failure (bad key,
// spent quota) is what actually surfaces here, as a real lastError_commute.
export const SOURCES = ["email", "calendar", "money", "brightspace", "marketNews", "weather", "commute"];

export const SOURCE_LABELS = {
  email: "Email",
  calendar: "Calendar",
  money: "Portfolio",
  brightspace: "Brightspace",
  marketNews: "Market news",
  weather: "Weather",
  commute: "Travel",
};
