// scheduler.js
//
// This is WHY the dashboard doesn't crash on page load: the AI/data calls
// never happen when someone opens the browser. They happen on a timer,
// in the background, and the browser just reads whatever was last saved.

import cron from "node-cron";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { runPipeline } from "./pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

export async function startScheduler() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
  const hours = config.schedule?.intervalHours || 2;

  // node-cron pattern for "every N hours"
  const pattern = `0 */${hours} * * *`;

  console.log(`[scheduler] Pipeline will run every ${hours} hour(s).`);
  cron.schedule(pattern, () => {
    runPipeline().catch(err => console.error("[scheduler] Pipeline error:", err));
  });

  // Also run once immediately on startup so there's data right away.
  runPipeline().catch(err => console.error("[scheduler] Initial run error:", err));
}
