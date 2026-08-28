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
export const SOURCES = ["email", "calendar", "money", "brightspace"];

export const SOURCE_LABELS = {
  email: "Email",
  calendar: "Calendar",
  money: "Portfolio",
  brightspace: "Brightspace",
};
