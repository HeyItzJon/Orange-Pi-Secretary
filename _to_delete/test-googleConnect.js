// scripts/test-googleConnect.js — buildAuthUrl() and isStateValid() only.
// The actual token exchange in server.js's callback route is I/O (an HTTP
// call to Google) and stays untested directly, same convention as
// collectMoney/collectSystemHealth elsewhere in this codebase.
//
// Run: node scripts/test-googleConnect.js

import assert from "node:assert/strict";
import { buildAuthUrl, isStateValid, OAUTH_STATE_TTL_MS } from "../lib/googleConnect.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("buildAuthUrl()");

test("points at Google's real auth endpoint", () => {
  const url = new URL(buildAuthUrl({ clientId: "abc", redirectUri: "http://x/y", state: "s1" }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
});

test("carries client_id, redirect_uri, and state through untouched", () => {
  const url = new URL(buildAuthUrl({ clientId: "my-client-id", redirectUri: "http://pi:3001/api/system/google/callback", state: "the-state-value" }));
  assert.equal(url.searchParams.get("client_id"), "my-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://pi:3001/api/system/google/callback");
  assert.equal(url.searchParams.get("state"), "the-state-value");
});

test("always requests offline access and forces the consent screen", () => {
  const url = new URL(buildAuthUrl({ clientId: "c", redirectUri: "http://x/y", state: "s" }));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("scope is exactly gmail.readonly + calendar.readonly, space-joined", () => {
  const url = new URL(buildAuthUrl({ clientId: "c", redirectUri: "http://x/y", state: "s" }));
  const scopes = url.searchParams.get("scope").split(" ");
  assert.deepEqual(scopes.sort(), [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
  ]);
});

test("missing clientId/redirectUri/state each throw rather than building a broken URL", () => {
  assert.throws(() => buildAuthUrl({ redirectUri: "http://x/y", state: "s" }));
  assert.throws(() => buildAuthUrl({ clientId: "c", state: "s" }));
  assert.throws(() => buildAuthUrl({ clientId: "c", redirectUri: "http://x/y" }));
});

group("isStateValid() — OAuth callback CSRF check");

test("matching state within the TTL is valid", () => {
  const now = Date.now();
  assert.equal(isStateValid({ state: "abc", createdAt: now - 1000 }, "abc", now), true);
});

test("mismatched state is invalid, even if fresh", () => {
  const now = Date.now();
  assert.equal(isStateValid({ state: "abc", createdAt: now }, "not-abc", now), false);
});

test("expired state (past the TTL) is invalid even if it matches", () => {
  const now = Date.now();
  const created = now - OAUTH_STATE_TTL_MS - 1;
  assert.equal(isStateValid({ state: "abc", createdAt: created }, "abc", now), false);
});

test("nothing stored (never requested, or already consumed) is invalid", () => {
  assert.equal(isStateValid(null, "abc", Date.now()), false);
});

test("no state on the incoming request is invalid", () => {
  assert.equal(isStateValid({ state: "abc", createdAt: Date.now() }, undefined, Date.now()), false);
  assert.equal(isStateValid({ state: "abc", createdAt: Date.now() }, "", Date.now()), false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
