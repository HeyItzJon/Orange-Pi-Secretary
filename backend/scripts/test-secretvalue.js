// scripts/test-secretvalue.js — lib/secretValue.js's cleanSecret, the
// thing that sanitizes whatever gets pasted into set-deepseek-key.js
// (and anything else that ever prompts for a secret the same way) before
// it's written to .env.
//
// Run: node scripts/test-secretvalue.js

import assert from "node:assert/strict";
import { cleanSecret } from "../lib/secretValue.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

group("cleanSecret — trims a pasted value, treats blank as \"nothing entered\"");

test("passes a normal value through unchanged", () => {
  assert.equal(cleanSecret("sk-abc123"), "sk-abc123");
});

test("trims leading/trailing whitespace a paste can leave behind", () => {
  assert.equal(cleanSecret("  sk-abc123  "), "sk-abc123");
});

test("trims a trailing newline from a terminal paste", () => {
  assert.equal(cleanSecret("sk-abc123\n"), "sk-abc123");
});

test("empty string becomes null, not an empty string written to .env", () => {
  assert.equal(cleanSecret(""), null);
});

test("whitespace-only input becomes null", () => {
  assert.equal(cleanSecret("   \n  "), null);
});

test("undefined input becomes null rather than throwing", () => {
  assert.equal(cleanSecret(undefined), null);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
