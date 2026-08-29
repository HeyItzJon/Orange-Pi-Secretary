// scripts/refresh-stock-idea-detail.js
//
// Force an immediate stock-idea DETAIL pull — the click-to-expand panel
// behind the Finances page's "Worth a look" card (lib/stockIdeaDetail.js) —
// bypassing its own once-a-calendar-day cache. Prints the full facts pulled
// from Yahoo (business summary, competitors, analyst targets) and the AI's
// three-part narrative, so a change to the prompt or the facts assembled
// can be checked without waiting for a real click, or for the next day.
//
// Defaults to whichever ticker is today's actual stock idea
// (moneySummary.stockIdea[0]) — pass a ticker explicitly to check any
// other symbol regardless of whether it's today's pick, and optionally
// "holding" as a second argument to preview the AI narrative the way an
// actual position (rather than a research candidate) gets framed:
//   node scripts/refresh-stock-idea-detail.js [TICKER] [holding]
//
// Run: node scripts/refresh-stock-idea-detail.js

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { init, getMeta } from "../lib/store.js";
import { getTickerDetail } from "../lib/stockIdeaDetail.js";
import { shortTicker } from "../brief/display.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8"));

await init();

let ticker = process.argv[2];
const context = process.argv[3] === "holding" ? "holding" : "idea";
if (!ticker) {
  const money = await getMeta("moneySummary", null);
  const pick = money?.stockIdea?.[0];
  if (!pick) {
    console.log("no stock idea on record yet and no ticker given — run `npm run refresh-stock-idea` first, or pass one explicitly");
    process.exit(1);
  }
  ticker = pick.symbol;
  console.log(`no ticker given — using today's actual pick: ${shortTicker(ticker)}\n`);
}

console.log(`pulling live detail for ${ticker} (context: ${context})...\n`);
const detail = await getTickerDetail(config, ticker, { force: true, context });

const { facts, ai } = detail;
console.log(`${facts.name} (${facts.ticker}) — $${facts.price} ${facts.currency || ""}`);
console.log(`${facts.sector || "unknown sector"}${facts.industry ? ` — ${facts.industry}` : ""}`);
console.log(facts.yahooUrl);
console.log(`\nBusiness summary: ${facts.businessSummary || "(none from Yahoo)"}`);
console.log(
  `\nAnalyst rating: ${facts.recommendationLabel || "no coverage"}` +
  (facts.numberOfAnalystOpinions ? ` (${facts.numberOfAnalystOpinions} analysts)` : "") +
  (facts.targetMeanPrice != null
    ? ` — mean target $${facts.targetMeanPrice} (${facts.analystUpsidePct >= 0 ? "+" : ""}${facts.analystUpsidePct}%)`
    : "")
);
console.log(
  facts.competitors.length
    ? `\nCompetitors: ${facts.competitors.map((c) => `${c.ticker} (${c.name})`).join(", ")}`
    : "\nCompetitors: none on file from Yahoo"
);

if (ai) {
  console.log(`\n--- AI narrative ---`);
  console.log(`Business: ${ai.business}`);
  if (ai.competitive) console.log(`Competitive: ${ai.competitive}`);
  if (ai.analysts) console.log(`Analysts: ${ai.analysts}`);
} else {
  console.log(`\n(no AI narrative — check DEEPSEEK_API_KEY / config.ai.provider)`);
}
