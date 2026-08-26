// scripts/get-refresh-token.js
//
// Mints a fresh GMAIL_REFRESH_TOKEN when the old one dies — expired
// (Google auto-expires an unverified/"Testing"-status OAuth client's
// refresh tokens after 7 days of disuse, or after 6 months regardless of
// use), revoked (a Google password change, or pulling this app's access
// under myaccount.google.com/permissions), or the client secret got
// rotated in Cloud Console. Any of those makes Gmail AND Calendar fail
// identically with the same error (see lib/google.js's getAccessToken —
// both share this one token) while Money keeps working fine, since it
// never touches Google at all.
//
// This version prints a Google consent URL and then asks you to paste
// back what you land on afterward, instead of running a local HTTP server
// to catch the redirect automatically. The automatic version only works
// when the browser completing the consent screen is running on THIS SAME
// machine — on a headless Pi with no browser, or when the consent URL
// gets opened on a phone or laptop instead, the redirect can never reach
// a listener running here, and the script just hangs forever waiting for
// a request that's never coming.
//
// Pasting the code instead works from any device: Google still redirects
// the browser to http://localhost:53682/oauth2callback?code=...&scope=...
// after you approve, even though nothing is listening on that port here —
// the browser just shows a "this site can't be reached" page. But the
// code is right there in the address bar. Copy the whole address (or just
// the code= value out of it) and paste it back at the prompt below; this
// script pulls the code out either way (see lib/oauthCode.js).
//
// Whatever the token exchange returns still gets written straight into
// THIS machine's backend/.env — never printed, never needing a manual
// retype of the actual refresh token — which is the part that fixes the
// original problem this script was rewritten for: a long refresh token
// line-wrapping in a terminal and getting mangled on a manual copy-paste
// into nano. Only the shorter, one-time authorization code is ever typed
// by hand now, and if that gets mistyped the token exchange below just
// fails cleanly with an error from Google — nothing silently corrupted.
//
//   node scripts/get-refresh-token.js
//
// Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET already in .env — those
// don't expire and aren't consumed by this, only the refresh token is.
// If the OAuth client itself was deleted in Cloud Console you'll need a
// new client id/secret from there first; this script can't create one.
//
// The authorization code Google hands back is single-use and only good
// for a few minutes — if the exchange below fails, just run this again
// from the top rather than trying to reuse the same code or URL.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import { stdin, stdout } from "process";
import { URL } from "url";
import axios from "axios";
import { getAccessToken } from "../lib/google.js";
import { writeEnvValue } from "../lib/envfile.js";
import { extractCode } from "../lib/oauthCode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error("Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env.");
  console.error("Get those from Google Cloud Console > APIs & Services > Credentials first.");
  process.exit(1);
}

// Doesn't need to be reachable — nothing listens on it. It only has to
// match one of the "Authorized redirect URIs" already registered on this
// OAuth client in Cloud Console, which it already does from past runs.
const REDIRECT_URI = "http://localhost:53682/oauth2callback";
// Read-only, matching exactly what lib/google.js ever does — list/read
// Gmail messages, list/read Calendar events. Nothing here sends mail,
// creates events, or modifies anything, so the token never needs more.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", GMAIL_CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
// Forces the consent screen every time — the one thing that actually
// issues a NEW refresh token. Without it, Google can silently return
// success with no refresh_token at all if this account already granted
// this app access before, which is exactly the situation a dead token
// needs fixed.
authUrl.searchParams.set("prompt", "consent");

console.log("\nOpen this URL in any browser signed into the right Google account —");
console.log("it does NOT have to be a browser on this machine:\n");
console.log(authUrl.toString());
console.log("\nAfter you approve, the browser will try to load a localhost address and");
console.log("fail (\"can't reach this page\" or similar) — that's expected, nothing is");
console.log("running there. Copy the FULL address from the address bar (or just the");
console.log("code= value out of it) and paste it at the prompt below.\n");

const rl = readline.createInterface({ input: stdin, output: stdout });
const pasted = await rl.question("Paste the redirect URL or code here: ");
rl.close();

const code = extractCode(pasted);
if (!code) {
  console.error("\nCouldn't find a code in that. Paste the whole address bar contents, or");
  console.error("just the value after \"code=\" — then run this again from the top, since");
  console.error("that code is now used up either way.\n");
  process.exit(1);
}

try {
  const { data } = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });

  if (!data.refresh_token) {
    console.error("\nGoogle didn't send back a refresh_token. prompt=consent above should");
    console.error("have prevented this — if you still hit it, revoke the app's access at");
    console.error("myaccount.google.com/permissions first, then run this again.\n");
    process.exit(1);
  }

  await writeEnvValue(ENV_PATH, "GMAIL_REFRESH_TOKEN", data.refresh_token);
  console.log("\nSaved — GMAIL_REFRESH_TOKEN in backend/.env now holds the new token.");
  console.log("(The previous .env was backed up to .env.bak, just in case.)");

  // Prove it actually works right now, on THIS run, rather than leaving
  // that to a separate `npm run doctor` — updating process.env directly
  // since dotenv already loaded the OLD value before this script wrote
  // the new one to disk.
  process.env.GMAIL_REFRESH_TOKEN = data.refresh_token;
  try {
    await getAccessToken();
    console.log("\nVerified — Google accepted the new token. Restart the service to pick it");
    console.log("up everywhere:\n");
    console.log("  sudo systemctl restart pi-secretary\n");
    process.exit(0);
  } catch (verifyErr) {
    console.error(`\nSaved it, but a live check still failed: ${verifyErr.message}`);
    console.error("That's unexpected right after minting a fresh token — worth investigating");
    console.error("before restarting the service on it.\n");
    process.exit(1);
  }
} catch (err) {
  console.error(`\nToken exchange failed: ${err.response?.data?.error_description || err.message}\n`);
  console.error("If that's \"invalid_grant\" or a redirect_uri mismatch, the code was likely");
  console.error("already used, expired (they're only good for a few minutes), or got cut off");
  console.error("in the paste — run this again from the top and paste the whole thing.\n");
  process.exit(1);
}
