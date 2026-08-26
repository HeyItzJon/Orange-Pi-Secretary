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
// code for a refresh token, and prints it.
//
//   node scripts/get-refresh-token.js
//
// Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET already in .env — those
// don't expire and aren't consumed by this, only the refresh token is.
// If the OAuth client itself was deleted in Cloud Console you'll need a
// new client id/secret from there first; this script can't create one.
//
// Run this on whichever machine has a browser handy and is signed into
// the right Google account — it doesn't have to be the Pi. The redirect
// has to land back on the SAME machine this is running on (it's a plain
// localhost server), so if you're SSH'd into a headless Pi with no
// browser, run this on your laptop instead (copy the two .env values
// over, or just clone the repo there) and paste the printed token into
// the Pi's .env over SSH afterward.

import "dotenv/config";
import http from "http";
import { URL } from "url";
import axios from "axios";

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

    console.log("\nNew refresh token — paste this into backend/.env as GMAIL_REFRESH_TOKEN");
    console.log("(replacing the old value), then restart the service:\n");
    console.log(data.refresh_token);
    console.log();
    process.exit(0);
  } catch (err) {
    res.end("Token exchange failed — check the terminal.");
    console.error(`\nToken exchange failed: ${err.response?.data?.error_description || err.message}\n`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
