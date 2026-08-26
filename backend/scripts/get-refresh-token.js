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
// Walks the standard "installed app" OAuth flow: prints a Google consent
// URL, catches the redirect on a short-lived local server, exchanges the
// code for a refresh token, and — this is the part that changed — writes
// it straight into backend/.env itself instead of printing it for a manual
// copy-paste. That copy-paste step is exactly where this went wrong the
// first time it was needed: a long token line-wraps in a terminal, and
// however it got copied (partial selection, a stray newline from pasting
// into nano) landed a mangled value in .env that Google's token endpoint
// rejected as a plain "Bad Request" — not even a recognizable token, just
// malformed. Writing it directly removes that whole failure mode.
//
//   node scripts/get-refresh-token.js
//
// Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET already in .env — those
// don't expire and aren't consumed by this, only the refresh token is.
// If the OAuth client itself was deleted in Cloud Console you'll need a
// new client id/secret from there first; this script can't create one.
//
// Run this ON WHICHEVER MACHINE SHOULD END UP WITH THE NEW TOKEN — it
// writes to THIS machine's own backend/.env, not any other machine's. The
// redirect also has to land back on this same machine (it's a plain
// localhost server), so if you're SSH'd into a headless Pi with no
// browser, run this on your laptop instead (against a clone of the repo
// there) and copy the token from that machine's .env to the Pi's over SSH
// — that's the one case a manual copy is still unavoidable, so take it
// slowly: select the whole value with a triple-click or your terminal's
// "select line" shortcut, not a click-drag that can silently drop the
// wrapped tail end.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { URL } from "url";
import axios from "axios";
import { getAccessToken } from "../lib/google.js";
import { writeEnvValue } from "../lib/envfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error("Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env.");
  console.error("Get those from Google Cloud Console > APIs & Services > Credentials first.");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
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

console.log("\nOpen this URL in a browser signed into the right Google account:\n");
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.end(`Google said: ${error}. Check the terminal and try again.`);
    console.error(`\nGoogle returned an error: ${error}\n`);
    server.close();
    process.exit(1);
    return;
  }

  try {
    const { data } = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });

    res.end("Done — you can close this tab and go back to the terminal.");
    server.close();

    if (!data.refresh_token) {
      console.error("\nGoogle didn't send back a refresh_token. prompt=consent above should");
      console.error("have prevented this — if you still hit it, revoke the app's access at");
      console.error("myaccount.google.com/permissions first, then run this again.\n");
      process.exit(1);
      return;
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
    res.end("Token exchange failed — check the terminal.");
    console.error(`\nToken exchange failed: ${err.response?.data?.error_description || err.message}\n`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
