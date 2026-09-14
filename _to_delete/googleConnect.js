// lib/googleConnect.js
//
// Backs the System page's "Reconnect" button (round 55 follow-up — Jon:
// "ideally I click the button for calendar and mail and they get
// connected automatically, minus the copy paste code thing"). Same OAuth
// mechanics as scripts/get-refresh-token.js's CLI flow (authorization-code
// grant, offline access, prompt=consent so re-approving always mints a
// fresh refresh token) — just driven by two server routes instead of a
// script: GET /api/system/google/connect (server.js) sends the browser
// straight to the URL this file builds, and GET /api/system/google/callback
// catches Google's redirect back and does the token exchange itself. No
// code ever gets copy-pasted by hand.
//
// buildAuthUrl() is pure and unit tested here. The token exchange itself
// (an HTTP POST to Google) lives inline in server.js's callback route,
// same convention as the rest of this codebase's untested I/O
// (collectMoney, quoteAll, collectSystemHealth, etc.).

import { GOOGLE_OAUTH_SCOPES } from "./google.js";

export function buildAuthUrl({ clientId, redirectUri, state }) {
  if (!clientId) throw new Error("buildAuthUrl: clientId is required");
  if (!redirectUri) throw new Error("buildAuthUrl: redirectUri is required");
  if (!state) throw new Error("buildAuthUrl: state is required");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  // Same reasoning as get-refresh-token.js: without this, Google can
  // silently return success with no refresh_token at all if this Google
  // account already granted the app access before — exactly the
  // situation a dead/expiring token needs fixed, so it's forced on every
  // reconnect rather than relying on first-consent behavior.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

// Ten minutes is generous for "click Reconnect, go through Google's
// consent screen, land back here" while still keeping a captured state
// value from being replayable indefinitely.
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Pure. Given the state stored server-side when /connect issued the auth
 * URL (or null/undefined if none was ever stored, or it was already
 * consumed) and the state Google handed back on the callback, decides
 * whether the callback is legitimate. Standard OAuth CSRF protection:
 * without checking this, anyone who could get the Pi's owner to click a
 * crafted link could bind an attacker-supplied authorization code to this
 * app's credentials.
 */
export function isStateValid(saved, receivedState, now = Date.now()) {
  if (!saved || !receivedState) return false;
  if (saved.state !== receivedState) return false;
  return now - saved.createdAt < OAUTH_STATE_TTL_MS;
}
