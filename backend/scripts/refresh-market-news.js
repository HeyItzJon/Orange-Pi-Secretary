// scripts/refresh-market-news.js
//
// Force an immediate market-news pull, bypassing the once-a-day gate on
// "Today's take" (config.marketNews.takeRefreshDays — see lib/marketTake.js).
// Prints the real indices/VIX, the headline list, any dead feeds, and the
// AI sentence, so a change to config.json's feed list or thresholds can be
// checked without waiting for the next 15-minute pull.
//
// Run: node scripts/refresh-market-news.js

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, getMeta } from "../lib/store.js";
import { collectMarketNews } from "../sources/marketNews.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

console.log("pulling real index/VIX data and RSS headlines...\n");
await collectMarketNews(config, { force: true });

const pulse = await getMeta("marketPulse", null);
if (!pulse) {
  console.log("nothing came back at all — check network access and config.marketNews.feeds");
  process.exit(1);
}

console.log(`as of ${pulse.at}:\n`);
if (pulse.indices?.length) {
  for (const i of pulse.indices) {
    console.log(`  ${i.label.padEnd(10)} ${i.pct == null ? "no data" : `${i.pct > 0 ? "+" : ""}${i.pct.toFixed(2)}%`}`);
  }
}
if (pulse.vix) console.log(`  ${"VIX".padEnd(10)} ${pulse.vix.value.toFixed(1)} (${pulse.vix.bucket})`);

console.log(`\n${pulse.headlines?.length || 0} headline(s):`);
for (const h of pulse.headlines || []) console.log(`  - [${h.source}] ${h.title}`);

if (pulse.feedErrors?.length) {
  console.log(`\ndead feed(s):`);
  for (const f of pulse.feedErrors) console.log(`  - ${f.name}: ${f.error}`);
}

console.log(`\ntoday's take: ${pulse.take || "(none yet — check DEEPSEEK_API_KEY / config.ai.provider)"}`);
