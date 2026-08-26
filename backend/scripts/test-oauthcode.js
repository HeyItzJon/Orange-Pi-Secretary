// scripts/test-oauthcode.js — lib/oauthCode.js's extractCode, the thing
// that reads whatever gets pasted into get-refresh-token.js's "paste the
// redirect URL or code here" prompt and pulls the actual authorization
// code out of it.
//
// Run: node scripts/test-oauthcode.js

import assert from "node:assert/strict";
import { extractCode } from "../lib/oauthCode.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("extractCode — pulling the auth code out of whatever got pasted back");

test("extracts code= from a full redirect URL with other params around it", () => {
  const url = "http://localhost:53682/oauth2callback?code=4/0Ab_abc123XYZ&scope=email";
  assert.equal(extractCode(url), "4/0Ab_abc123XYZ");
});

test("extracts code= when it's the only param", () => {
  assert.equal(extractCode("http://localhost:53682/oauth2callback?code=onlyparam"), "onlyparam");
});

test("decodes a URL-encoded code value", () => {
  const url = "http://localhost:53682/oauth2callback?code=4%2F0Ab_encoded%3D%3D&scope=email";
  assert.equal(extractCode(url), "4/0Ab_encoded==");
});

test("accepts a bare 'code=...' fragment pasted alone, not a full URL", () => {
  assert.equal(extractCode("code=just-the-fragment"), "just-the-fragment");
});

test("accepts a bare code with no 'code=' prefix at all", () => {
  assert.equal(extractCode("4/0Ab_bare_value"), "4/0Ab_bare_value");
});

test("trims surrounding whitespace from a pasted value", () => {
  assert.equal(extractCode("  4/0Ab_padded  \n"), "4/0Ab_padded");
});

test("returns null for empty input", () => {
  assert.equal(extractCode(""), null);
  assert.equal(extractCode("   "), null);
  assert.equal(extractCode(undefined), null);
});

test("returns null for a URL with no code param (e.g. the user denied consent)", () => {
  assert.equal(extractCode("http://localhost:53682/oauth2callback?error=access_denied"), null);
});

test("returns null for a malformed URL-looking string", () => {
  assert.equal(extractCode("http://"), null);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
