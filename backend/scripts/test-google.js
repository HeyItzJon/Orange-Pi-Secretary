// scripts/test-google.js — lib/google.js's own error-message enrichment.
//
// Everything else in lib/google.js is a real network call (token exchange,
// Gmail, Calendar), not worth mocking here. googleErrorMessage() is the one
// pure function underneath all of them — the thing that turns axios's
// generic "Request failed with status code 400" into Google's own, actually
// useful error text — and it's exactly the piece a real bug (Jon's dead
// refresh token, both Gmail and Calendar suddenly failing identically)
// depends on being right.
//
// Run: node scripts/test-google.js

import assert from "node:assert/strict";
import { googleErrorMessage, findBodyText } from "../lib/google.js";

const b64url = (s) => Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("googleErrorMessage — Google's own reason, not axios's generic one");

test("the OAuth token endpoint's shape (a dead refresh token) surfaces error + error_description", () => {
  const err = {
    message: "Request failed with status code 400",
    response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
  };
  assert.equal(googleErrorMessage(err), "invalid_grant — Token has been expired or revoked.");
});

test("the regular Gmail/Calendar API's shape surfaces the nested error.message plus the status", () => {
  const err = {
    message: "Request failed with status code 403",
    response: { status: 403, data: { error: { code: 403, message: "Calendar usage limits exceeded." } } },
  };
  assert.equal(googleErrorMessage(err), "Calendar usage limits exceeded. (HTTP 403)");
});

test("a response with neither known shape falls back to the plain HTTP status", () => {
  const err = { message: "Request failed with status code 500", response: { status: 500, statusText: "Internal Server Error", data: "<html>oops</html>" } };
  assert.equal(googleErrorMessage(err), "HTTP 500 Internal Server Error");
});

test("no response at all (timeout, DNS failure, offline Pi) falls back to axios's own message", () => {
  const err = { message: "timeout of 15000ms exceeded" };
  assert.equal(googleErrorMessage(err), "timeout of 15000ms exceeded");
});

group("findBodyText — full-body extraction from a Gmail payload (see getMessagesBody)");

test("a simple single-part text/plain message decodes straight through", () => {
  const payload = { mimeType: "text/plain", body: { data: b64url("Assignment due Friday at noon.") } };
  assert.equal(findBodyText(payload), "Assignment due Friday at noon.");
});

test("a multipart message prefers text/plain over a sibling text/html part", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: b64url("<p>HTML version</p>") } },
      { mimeType: "text/plain", body: { data: b64url("Plain version") } },
    ],
  };
  assert.equal(findBodyText(payload), "Plain version");
});

test("an HTML-only message falls back to text/html, stripped of tags", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/html", body: { data: b64url("<p>Your <b>invoice</b> is due <br>tomorrow.</p>") } }],
  };
  const text = findBodyText(payload);
  assert.ok(!text.includes("<"), "no raw tags leak through");
  assert.ok(text.includes("Your"), "keeps the actual words");
  assert.ok(text.includes("invoice"));
  assert.ok(text.includes("tomorrow"));
});

test("nested multipart (a real Gmail shape: mixed > alternative > plain/html) is still found", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Nested plain text body.") } },
          { mimeType: "text/html", body: { data: b64url("<p>Nested html</p>") } },
        ],
      },
      { mimeType: "application/pdf", body: { attachmentId: "abc123" } }, // no inline data — must not crash
    ],
  };
  assert.equal(findBodyText(payload), "Nested plain text body.");
});

test("a message with no usable body text (attachment-only, or missing payload) returns an empty string, never throws", () => {
  assert.equal(findBodyText(null), "");
  assert.equal(findBodyText({ mimeType: "multipart/mixed", parts: [{ mimeType: "application/pdf", body: { attachmentId: "x" } }] }), "");
  assert.equal(findBodyText({ mimeType: "text/plain", body: {} }), "");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
