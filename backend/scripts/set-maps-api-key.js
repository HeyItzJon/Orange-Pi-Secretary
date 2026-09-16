// scripts/set-maps-api-key.js
//
// Paste your new GOOGLE_MAPS_API_KEY straight into backend/.env — no nano,
// no hand-editing a file that also holds every other secret, and no
// pasting the key into a chat with Claude either. Same reasoning, and the
// same writeEnvValue()/cleanSecret() machinery, as
// scripts/set-deepseek-key.js and scripts/set-brightspace-url.js: a key
// retyped by hand into an editor is a key that can get truncated or
// mangled on the way in.
//
// Where to get the key: Google Cloud Console > APIs & Services >
// Credentials > Create Credentials > API key, in whichever project has
// the Routes API enabled with billing attached and a daily quota cap set
// (see claude/commute-eta-plan.md in the project docs for the full setup
// walkthrough — restrict the key to Routes API only).
//
//   node scripts/set-maps-api-key.js
//
// Run this on WHICHEVER machine actually runs the backend — the Pi, if
// that's what's deployed, or this machine for local dev. .env is never
// synced by git (see .gitignore), so a key saved here doesn't travel to
// any other machine on its own; run this again on each one that needs it.
//
// This checks the key against a real, but harmless and generic, Routes
// API call before telling you to restart — two public Ottawa points, not
// your actual home or class locations — so a bad paste, an unenabled API,
// or an already-spent quota shows up right here instead of surfacing
// later as a silently-missing commute ETA on the wall.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import { stdin, stdout } from "process";
import axios from "axios";
import { writeEnvValue } from "../lib/envfile.js";
import { cleanSecret } from "../lib/secretValue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");
const ENV_KEY = "GOOGLE_MAPS_API_KEY";

// Parliament Hill -> Carleton University: a real Ottawa driving route, but
// nowhere near Jon's actual home or class locations, so this verification
// call never touches (or logs, on Google's side) his real commute
// endpoints.
const TEST_ORIGIN = { latitude: 45.4235, longitude: -75.7009 };
const TEST_DEST = { latitude: 45.3876, longitude: -75.696 };

console.log("\nGet the key from Google Cloud Console > APIs & Services > Credentials");
console.log("(see claude/commute-eta-plan.md for the full setup walkthrough) if you");
console.log("don't have it copied already.\n");

const rl = readline.createInterface({ input: stdin, output: stdout });
const pasted = await rl.question(`Paste the new ${ENV_KEY}: `);
rl.close();

const value = cleanSecret(pasted);
if (!value) {
  console.error("\nNothing pasted — .env left unchanged.\n");
  process.exit(1);
}

await writeEnvValue(ENV_PATH, ENV_KEY, value);
console.log(`\nSaved — ${ENV_KEY} in backend/.env now holds the new key.`);
console.log("(The previous .env was backed up to .env.bak, just in case.)");

console.log("\nChecking it against the Routes API (a harmless generic Ottawa route,");
console.log("not your real commute)...");
try {
  const res = await axios.post(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      origin: { location: { latLng: TEST_ORIGIN } },
      destination: { location: { latLng: TEST_DEST } },
      travelMode: "DRIVE",
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": value,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      timeout: 15000,
    }
  );
  const route = res.data.routes?.[0];
  const minutes = route ? Math.round(parseInt(route.duration, 10) / 60) : "?";
  const km = route ? (route.distanceMeters / 1000).toFixed(1) : "?";
  console.log(`\nVerified — Routes API accepted the key and returned a real route`);
  console.log(`(${km} km, ~${minutes} min, for the test points). Restart the service to`);
  console.log("pick it up everywhere:\n");
  console.log("  sudo systemctl restart pi-secretary\n");
  process.exit(0);
} catch (err) {
  const status = err.response?.status;
  const reason = err.response?.data?.error?.message || err.message;
  console.error(`\nSaved it, but a live check failed: ${reason}`);
  if (status === 403 || status === 401) {
    console.error("That's an auth/permission error — double check the key was copied in");
    console.error("full, that the Routes API is actually Enabled on that Cloud project, and");
    console.error("that the key's API restriction includes Routes API.\n");
  } else if (status === 429 || /RESOURCE_EXHAUSTED/.test(reason)) {
    console.error("That looks like the daily quota cap — expected if you set it low; try");
    console.error("again tomorrow, or raise the quota a bit in Cloud Console.\n");
  } else {
    console.error("Worth investigating before restarting the service on it.\n");
  }
  process.exit(1);
}
