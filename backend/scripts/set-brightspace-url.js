// scripts/set-brightspace-url.js
//
// Paste your Brightspace/D2L Calendar subscription URL straight into
// backend/.env as BRIGHTSPACE_ICS_URL — no editor, no hand-typing a long
// URL into nano. Same reasoning, and the same writeEnvValue()/cleanSecret()
// machinery, as scripts/set-deepseek-key.js and scripts/get-refresh-token.js:
// a value retyped by hand into an editor is a value that can get truncated
// or mangled on the way in, and this one especially — Brightspace's own
// subscription URLs run well past 100 characters — is exactly the kind that
// breaks when line-wrapped in a terminal and copied by eye.
//
// Where to find the URL: in Brightspace, open Calendar, then look for
// "Subscribe" / "Create a Google Calendar Subscription" (wording varies by
// school's D2L version) — it hands you a webcal:// or https:// link ending
// in something like ".ics?..." with a long token in it. Copy the whole
// thing.
//
//   node scripts/set-brightspace-url.js
//
// Run this on WHICHEVER machine actually runs the backend — the Pi, if
// that's what's deployed, or this machine for local dev. .env is never
// synced by git (see .gitignore), so a URL saved here doesn't travel to any
// other machine on its own; run this again on each one that needs it.
//
// This checks the URL by actually fetching it and confirming it looks like
// a real calendar feed before telling you to restart — a bad paste (wrong
// URL, an expired/revoked subscription link) shows up right here instead of
// surfacing later as a silently-empty Brightspace source.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import { stdin, stdout } from "process";
import axios from "axios";
import { writeEnvValue } from "../lib/envfile.js";
import { cleanSecret } from "../lib/secretValue.js";
import { parseFeed } from "../sources/brightspace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");
const ENV_KEY = "BRIGHTSPACE_ICS_URL";

console.log("\nIn Brightspace: Calendar > Subscribe (wording varies by school) to get the");
console.log("link, if you don't have it copied already.\n");

const rl = readline.createInterface({ input: stdin, output: stdout });
const pasted = await rl.question(`Paste your ${ENV_KEY}: `);
rl.close();

let value = cleanSecret(pasted);
if (!value) {
  console.error("\nNothing pasted — .env left unchanged.\n");
  process.exit(1);
}

// Brightspace sometimes hands out a webcal:// link (that's just https:// by
// another name, meant for a calendar app to auto-subscribe) — axios has no
// idea what to do with that scheme, so swap it before ever trying to fetch.
if (value.startsWith("webcal://")) {
  value = `https://${value.slice("webcal://".length)}`;
  console.log("(swapped webcal:// for https:// — same feed, axios just needs the real scheme)");
}

await writeEnvValue(ENV_PATH, ENV_KEY, value);
console.log(`\nSaved — ${ENV_KEY} in backend/.env now holds the new URL.`);
console.log("(The previous .env was backed up to .env.bak, just in case.)");

console.log("\nFetching it now to make sure it's really a calendar feed...");
try {
  const res = await axios.get(value, { timeout: 20000, responseType: "text" });
  const events = parseFeed(res.data);
  console.log(`\nVerified — that's a real calendar feed with ${events.length} entr${events.length === 1 ? "y" : "ies"} on it right now.`);
  console.log("Restart the service to pick it up:\n");
  console.log("  sudo systemctl restart pi-secretary\n");
  process.exit(0);
} catch (err) {
  const reason = err.response ? `HTTP ${err.response.status}` : err.message;
  console.error(`\nSaved it, but fetching it back just now failed: ${reason}`);
  console.error("Double-check the URL was copied in full and that the subscription link");
  console.error("hasn't been regenerated/revoked on Brightspace's side since you copied it.\n");
  process.exit(1);
}
