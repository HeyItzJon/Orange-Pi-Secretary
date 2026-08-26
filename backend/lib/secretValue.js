// lib/secretValue.js
//
// Cleans up a value pasted into a terminal prompt before it goes into
// .env — trims the whitespace and stray newlines a paste can leave
// behind, and treats an empty result as "nothing was entered" rather than
// silently writing a blank value over a working key.

export function cleanSecret(input) {
  const trimmed = (input || "").trim();
  return trimmed || null;
}
