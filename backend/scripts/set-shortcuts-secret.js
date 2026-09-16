// scripts/set-shortcuts-secret.js
//
// Generates a fresh SHORTCUTS_SECRET and writes it straight into
// backend/.env — the shared secret both of the round-92 iOS Shortcuts
// (location, alarm) send as an X-Shortcut-Secret header, since those are
// the only two write endpoints in this app meant to be hit by an
// unattended automation rather than a person's own click on the
// dashboard. See server.js's checkShortcutSecret() for how it's checked.
//
// Unlike set-maps-api-key.js/set-deepseek-key.js, there's nothing to
// paste here — this SERVER makes up the secret, and you copy it into
// BOTH Shortcuts' headers (see claude/round-92-shortcuts-location-and-alarm.md
// for the exact Shortcuts steps). Re-run this any time you want to rotate
// it; every Shortcut using the old value will need updating to match.
//
//   node scripts/set-shortcuts-secret.js
//
// Run this on WHICHEVER machine actually runs the backend — the Pi, if
// that's what's deployed. .env is never synced by git (see .gitignore),
// so a secret saved here doesn't travel to any other machine on its own.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { writeEnvValue } from "../lib/envfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");
const ENV_KEY = "SHORTCUTS_SECRET";

if (process.env[ENV_KEY]) {
  console.log(`\n${ENV_KEY} is already set in backend/.env.`);
  console.log("Re-running this will generate a NEW one — every Shortcut using the old");
  console.log("value will stop working until you update it there too.\n");
}

// 32 random bytes as hex (64 chars) — long enough to never realistically
// guess, short enough to paste into a Shortcut's header field without
// fuss. No characters that need escaping in a header value or a URL.
const value = crypto.randomBytes(32).toString("hex");

await writeEnvValue(ENV_PATH, ENV_KEY, value);

console.log(`\nSaved — ${ENV_KEY} in backend/.env now holds:\n`);
console.log(`  ${value}\n`);
console.log("Restart the service to pick it up:\n");
console.log("  sudo systemctl restart pi-secretary\n");
console.log("Then, in BOTH iOS Shortcuts (location and alarm), add a header named");
console.log("X-Shortcut-Secret with exactly this value — see");
console.log("claude/round-92-shortcuts-location-and-alarm.md for the full setup.\n");
console.log("(The previous .env was backed up to .env.bak, just in case.)");
