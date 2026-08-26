// scripts/test-paths.js — expandHome (the `~` a shell expands but Node
// never does) and resolveVaultPath (the fix for config.json's vault path
// silently becoming wrong the moment it's git-pulled onto a different
// machine than whichever one last committed it).
//
// Run: node scripts/test-paths.js

import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { expandHome, resolveVaultPath } from "../lib/paths.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  const savedEnv = process.env.VAULT_PATH;
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
  finally {
    if (savedEnv === undefined) delete process.env.VAULT_PATH;
    else process.env.VAULT_PATH = savedEnv;
  }
}

group("expandHome — the shell's `~` convention, which fs/path never apply on their own");

test("bare ~ becomes the home directory", () => {
  assert.equal(expandHome("~"), os.homedir());
});

test("~/... becomes homedir/...", () => {
  assert.equal(expandHome("~/Obsidian"), path.join(os.homedir(), "Obsidian"));
});

test("a real absolute path (Windows or Linux) passes through unchanged", () => {
  assert.equal(expandHome("C:\\Users\\jonmb\\Documents\\Obsidian"), "C:\\Users\\jonmb\\Documents\\Obsidian");
  assert.equal(expandHome("/home/jonbourgy/Obsidian"), "/home/jonbourgy/Obsidian");
});

test("empty/missing input passes through as-is, no crash", () => {
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome(""), "");
});

group("resolveVaultPath — VAULT_PATH in .env beats config.json, so a git pull from a different machine can't clobber it");

test("with no VAULT_PATH set, falls back to config.vault.path", () => {
  delete process.env.VAULT_PATH;
  const r = resolveVaultPath({ vault: { path: "~/Obsidian" } });
  assert.equal(r.path, path.join(os.homedir(), "Obsidian"));
  assert.equal(r.source, "config.json");
});

test("VAULT_PATH overrides config.json entirely — this is the actual bug fix", () => {
  process.env.VAULT_PATH = "/home/jonbourgy/Obsidian";
  // Simulates exactly what happened: config.json carries a path committed
  // from Windows, but this machine's own .env should win regardless.
  const r = resolveVaultPath({ vault: { path: "C:\\Users\\jonmb\\Documents\\Obsidian\\Jon's Synced Vault" } });
  assert.equal(r.path, "/home/jonbourgy/Obsidian");
  assert.equal(r.source, "VAULT_PATH env var");
});

test("VAULT_PATH itself still gets ~ expanded", () => {
  process.env.VAULT_PATH = "~/Obsidian";
  const r = resolveVaultPath({});
  assert.equal(r.path, path.join(os.homedir(), "Obsidian"));
});

test("falls back through the older notes.vaultPath and vaultPath spellings, in order", () => {
  delete process.env.VAULT_PATH;
  assert.equal(resolveVaultPath({ notes: { vaultPath: "/a" } }).path, "/a");
  assert.equal(resolveVaultPath({ vaultPath: "/b" }).path, "/b");
  assert.equal(resolveVaultPath({ vault: { path: "/a" }, notes: { vaultPath: "/b" }, vaultPath: "/c" }).path, "/a");
});

test("nothing set anywhere resolves to a falsy path, not a crash", () => {
  delete process.env.VAULT_PATH;
  assert.equal(resolveVaultPath({}).path, undefined);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
