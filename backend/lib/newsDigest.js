// lib/newsDigest.js
//
// Three headlines, DeepSeek-compressed for the LED wall's News screen
// (round 74 — Jon: "run them through DeepSeek so it can compress the shit
// out of our headlines... very, very targeted information... maximum
// three headlines, the most relevant for the day"). Same guardrail as
// lib/marketTake.js: the model only ever selects and rewrites headlines it
// was actually given — it never invents a story, a source, or a fact not
// present in the input.
//
// Cached by content hash (lib/ids.js's cacheKey), NOT a calendar-day gate
// like marketTake.js's "one sentence a day" — headlines genuinely turn
// over through the day and a once-daily digest would go stale exactly the
// way the old raw feed didn't. Content-hash caching gets the same cost
// discipline a day-gate would (DeepSeek is only called again once the
// underlying headline set actually changes, not on every 15-minute pull
// if nothing new came in) without pinning the digest to a fixed refresh
// schedule.
//
// Degrades to null on any failure (missing key, provider off, malformed
// response, nothing to summarize) — callers should fall back to the raw
// headlines sources/marketNews.js already collected, same "never gate the
// real data on the AI step" convention marketTake.js documents.

import { ask } from "./ai.js";
import { cacheKey } from "./ids.js";
import { logger } from "./log.js";

const log = logger("newsDigest");

const SYSTEM = `You pick and rewrite headlines for a tiny scrolling LED display (192 pixels wide), from a list of real financial news headlines.

Return json: {"headlines":[{"title":"...","source":"..."}, ...]}

Rules:
- Choose exactly 3 headlines — the ones most relevant to a personal investor's day. Choose fewer only if fewer than 3 are given.
- Only choose from the headlines listed below. Never invent a headline, a source, or a fact not present in the input.
- Rewrite each chosen title to be short and punchy — aim for under 70 characters. Cut filler words, keep the concrete fact (company, number, event). No commentary, no opinion, no hype.
- "source" must be copied exactly from the matching input headline's source.
- Compress wording only — never change what actually happened.`;

function fmtForPrompt(headlines) {
  return headlines.map((h, i) => `${i + 1}. [${h.source || "unknown"}] ${h.title}`).join("\n");
}

/**
 * `pulse` is the freshly-collected marketPulse blob (sources/marketNews.js)
 * — only `.headlines` is used here. `previous` is the last stored
 * marketPulse blob, read only for its `.newsDigest`/`.newsDigestAt` as a
 * fallback if this run produces nothing usable. Returns `{headlines, at}`
 * — `headlines` is null when there's nothing to summarize or the model
 * call failed outright; callers fall back to the raw headlines in that
 * case, same as marketTake.js's take going quiet doesn't block the real
 * indices/headlines from showing.
 */
export async function getNewsDigest(config, pulse, { previous = null } = {}) {
  const raw = (pulse?.headlines || []).filter((h) => h?.title);
  if (!raw.length) return { headlines: null, at: previous?.newsDigestAt || null };

  const key = cacheKey("newsDigest-v1", { titles: raw.map((h) => h.title) });
  const parsed = await ask({
    system: SYSTEM,
    user: `Return json.\n\n${fmtForPrompt(raw)}`,
    config,
    maxTokens: 300,
    json: true,
    cacheAs: key,
  });

  const headlines = Array.isArray(parsed?.headlines)
    ? parsed.headlines
        .filter((h) => h && typeof h.title === "string" && h.title.trim())
        .slice(0, 3)
        .map((h) => ({ title: h.title.trim().slice(0, 90), source: h.source || null }))
    : null;

  if (!headlines || !headlines.length) {
    return { headlines: previous?.newsDigest || null, at: previous?.newsDigestAt || null };
  }

  const at = new Date().toISOString();
  log.info(`refreshed: ${headlines.map((h) => h.title).join(" | ")}`);
  return { headlines, at };
}
