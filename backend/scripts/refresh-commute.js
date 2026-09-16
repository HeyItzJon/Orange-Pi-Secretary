// scripts/refresh-commute.js
//
// Force an immediate commute/ETA computation and print exactly what it
// decided — which event it's driving you to, from where it thinks you
// currently are, which route won, and the final buffered commuteMin — so a
// change to config.commute (a new location, a different buffer) or a fresh
// GOOGLE_MAPS_API_KEY can be checked without waiting for the next
// scheduler tick.
//
// Run: node scripts/refresh-commute.js

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, getMeta } from "../lib/store.js";
import { refreshCommute } from "../lib/commute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

if (!config.commute?.enabled) {
  console.log("config.commute.enabled is false (or the section is missing) — nothing to compute.");
  console.log("See config.example.json's 'commute' section for the shape to add.");
  process.exit(1);
}
if (!process.env.GOOGLE_MAPS_API_KEY) {
  console.log("No GOOGLE_MAPS_API_KEY in .env — run `npm run set-maps-api-key` first.");
  process.exit(1);
}

console.log("computing today's commute against the real Routes API...\n");
await refreshCommute(config);

const c = await getMeta("commute", null);
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone || "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

if (!c || c.day !== today) {
  console.log("Nothing to report — either there's no upcoming event today with a resolved");
  console.log("location, or a routing call failed (check the logs above for a Routes API error).");
  process.exit(0);
}

console.log(`for event: ${c.eventId}`);
console.log(`destination: ${c.label}${c.route ? ` (route: ${c.route})` : ""}`);
console.log(`commuteMin: ${c.minutes}  <-- this is what /api/matrix will send, and what`);
console.log(`            the wall's Commuting screen will show as "N MIN TO <event>"`);
console.log(`computed at: ${c.computedAt}`);
