// scripts/prune.js
//
// Runs the store's hygiene sweep right now instead of waiting for the
// scheduler's once-daily pass (see lib/scheduler.js) — mainly useful the
// first time this ships, to clear out whatever already accumulated before
// prune() was actually wired into the live server, and any time you just
// don't want to wait until tomorrow's brief time.
//
//   npm run prune
//
// Safe to run any time; it only ever removes done/dismissed items past
// config.brief.retainDays, or Brightspace items past
// config.brightspace.maxPastDays that are still sitting around as "open"
// (see lib/store.js's prune() for why Brightspace gets its own, more
// aggressive rule — its feed can span your whole enrollment history, and
// nothing else ever marks an old assignment "done").

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, prune } from "../lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

const removed = await prune({
  maxAgeDays: config.brief?.retainDays ?? 90,
  brightspaceMaxPastDays: config.brightspace?.maxPastDays ?? 14,
});

console.log(removed ? `Removed ${removed} stale item(s).` : "Nothing to remove — already clean.");
process.exit(0);
