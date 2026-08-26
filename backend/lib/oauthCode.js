// lib/oauthCode.js
//
// Pulls the OAuth "code" query param out of whatever
// scripts/get-refresh-token.js's paste-back step receives — either the
// full address-bar contents Google redirected the browser to, or just the
// code value on its own (or a "code=..." fragment someone triple-clicked
// out of the middle of the address bar). Kept separate from
// get-refresh-token.js so this parsing — the part most likely to get an
// edge case wrong — has its own tests.

/**
 * Returns the decoded `code` value from `input`, or null if none can be
 * found. Accepts a full URL (with or without other query params), a bare
 * "code=..." fragment, or a bare code with nothing else around it.
 */
export function extractCode(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).searchParams.get("code");
    } catch {
      return null;
    }
  }

  const match = trimmed.match(/code=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]);

  return trimmed;
}
