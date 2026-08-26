// scripts/test-envfile.js — lib/envfile.js's writeEnvValue, the thing that
// now saves a fresh GMAIL_REFRESH_TOKEN straight into .env instead of
// asking for a manual copy-paste (see scripts/get-refresh-token.js — that
// copy-paste step is exactly what mangled a token once already).
//
// Run: node scripts/test-envfile.js

import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { writeEnvValue } from "../lib/envfile.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
async function test(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

// A fresh temp file per test, so nothing here ever touches a real .env.
async function tmpEnvPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envfile-test-"));
  return path.join(dir, ".env");
}

group("writeEnvValue — one KEY=value line changed, everything else untouched");

await test("replaces an existing key's value, leaving every other line exactly as it was", async () => {
  const p = await tmpEnvPath();
  await fs.writeFile(p, "FOO=old\nGMAIL_REFRESH_TOKEN=stale\nBAR=keep-me\n", "utf-8");
  await writeEnvValue(p, "GMAIL_REFRESH_TOKEN", "fresh-token-value");
  const out = await fs.readFile(p, "utf-8");
  assert.equal(out, "FOO=old\nGMAIL_REFRESH_TOKEN=fresh-token-value\nBAR=keep-me\n");
});

await test("appends the key if it isn't present yet, instead of silently doing nothing", async () => {
  const p = await tmpEnvPath();
  await fs.writeFile(p, "FOO=old\n", "utf-8");
  await writeEnvValue(p, "GMAIL_REFRESH_TOKEN", "brand-new");
  const out = await fs.readFile(p, "utf-8");
  assert.equal(out, "FOO=old\nGMAIL_REFRESH_TOKEN=brand-new\n");
});

await test("creates the file from scratch if it doesn't exist at all (ENOENT), rather than throwing", async () => {
  const p = await tmpEnvPath(); // directory exists, the .env file itself doesn't yet
  await writeEnvValue(p, "GMAIL_REFRESH_TOKEN", "first-value");
  const out = await fs.readFile(p, "utf-8");
  assert.equal(out, "GMAIL_REFRESH_TOKEN=first-value\n");
});

await test("backs up the previous contents to .env.bak before overwriting", async () => {
  const p = await tmpEnvPath();
  await fs.writeFile(p, "GMAIL_REFRESH_TOKEN=stale\n", "utf-8");
  await writeEnvValue(p, "GMAIL_REFRESH_TOKEN", "fresh");
  const backup = await fs.readFile(`${p}.bak`, "utf-8");
  assert.equal(backup, "GMAIL_REFRESH_TOKEN=stale\n");
});

await test("no backup file is written when there was nothing to back up (fresh file)", async () => {
  const p = await tmpEnvPath();
  await writeEnvValue(p, "GMAIL_REFRESH_TOKEN", "first-value");
  await assert.rejects(() => fs.access(`${p}.bak`));
});

await test("appending never leaves a stray blank line in the middle of the file", async () => {
  const p = await tmpEnvPath();
  await fs.writeFile(p, "FOO=old\n\n", "utf-8"); // trailing blank line, as a real editor might leave
  await writeEnvValue(p, "GMAIL_REFRESH_TOKEN", "brand-new");
  const out = await fs.readFile(p, "utf-8");
  assert.equal(out, "FOO=old\nGMAIL_REFRESH_TOKEN=brand-new\n");
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
