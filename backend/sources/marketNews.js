// sources/marketNews.js
//
// The Finances page's market-context panel, phase 1 (see
// claude/finances-page-ai-plan.md in the project for the full design):
//
//   - Real index levels (S&P 500 / TSX / Nasdaq) and the VIX, pulled from
//     the same Yahoo Finance library sources/money.js already uses for
//     prices. Zero AI, zero signup, always as current as the last pull.
//   - Real headlines from a handful of free RSS feeds. No API key, no
//     account, no quota — same reasoning an earlier (never-built) design
//     in this project gave for choosing RSS over a paid news API.
//   - One DeepSeek sentence a day (lib/marketTake.js) that reads the real
//     numbers and headlines above and writes ONE summary line. It is never
//     asked to predict, recommend, or invent a figure — see that file's
//     own header for the exact guardrail.
//
// Deliberately produces NO items: nothing here is a thing to do, the same
// reasoning the (also never-built) news.js design gave — putting "S&P 500
// +0.4%" in the same store as "midterm due Friday" would be a category
// error. This just writes one meta blob, `marketPulse`, that
// brief/display.js reads for the Finances page.
//
// A feed going dark shows up as a named entry in `feedErrors` (surfaced on
// the page as "Feed unavailable: X") and in the sources panel / doctor,
// rather than silently shrinking the headline list — same convention as
// every other source in this app. Only if EVERY feed fails and no index
// data comes back either does this throw, so it's counted as a real source
// error like a dead Brightspace feed — a single dead feed among several
// healthy ones is not that.

import axios from "axios";
import YahooFinance from "yahoo-finance2";
import { logger } from "../lib/log.js";
import { getMeta, setMeta } from "../lib/store.js";
import { getMarketTake } from "../lib/marketTake.js";

const log = logger("marketNews");
const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export const DEFAULT_FEEDS = [
  { name: "CNBC", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { name: "Financial Post", url: "https://financialpost.com/feed" },
];

export const DEFAULT_INDICES = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^GSPTSE", label: "TSX" },
  { symbol: "^IXIC", label: "Nasdaq" },
];

export const DEFAULT_VIX_SYMBOL = "^VIX";

// ------------------------------------------------------------- RSS parsing

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ",
};

/** RSS/Atom feeds carry titles either plain, CDATA-wrapped, or HTML-entity
 *  escaped — this handles all three without pulling in an XML parser for
 *  what is, for the handful of well-formed feeds this reads, simple
 *  regular text extraction. */
export function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
    .replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, code) => {
      if (code[0] === "#") {
        const cp = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return code in ENTITIES ? ENTITIES[code] : m;
    })
    .trim();
}

function tag(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

/** Atom's <link> is a self-closing tag with an href attribute, not text
 *  content — RSS's is plain text. Try RSS shape first since every feed
 *  this app actually points at is RSS 2.0; Atom is a fallback for
 *  whatever else ends up in the feed list later. */
function linkOf(block) {
  const rss = block.match(/<link\b[^>]*>([^<]*)<\/link>/i);
  if (rss && rss[1].trim()) return decodeEntities(rss[1]);
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  return atom ? decodeEntities(atom[1]) : null;
}

function isoOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parses one already-fetched RSS/Atom XML string into plain headline
 * objects — split out from fetchFeed() so scripts/test-market-news.js can
 * exercise real parsing against small synthetic fixtures, no network call
 * (same pattern sources/brightspace.js's parseFeed() already uses).
 * `source` is stamped onto every returned headline so a merged list from
 * several feeds still knows where each one came from.
 */
export function parseRssFeed(xml, source = null) {
  if (!xml) return [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];

  return blocks
    .map((block) => {
      const title = tag(block, ["title"]);
      if (!title) return null;
      const link = linkOf(block);
      const publishedAt = isoOf(tag(block, ["pubDate", "published", "updated"]));
      return { title, link, publishedAt, source };
    })
    .filter(Boolean);
}

/**
 * Newest first, deduped by a loose case/punctuation-insensitive match on
 * the title — two outlets running the same wire story is common enough
 * that without this, "In the news" would just show the same headline
 * twice. Caps to `count`. Pure and exported so this can be unit tested
 * without mocking any network call.
 */
export function dedupeHeadlines(headlines, count = 6) {
  const seen = new Set();
  return (headlines || [])
    .slice()
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .filter((h) => {
      const key = (h.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count);
}

/** VIX bucketed into a plain-language read, thresholds tunable in config —
 *  same rule-based bucketing colorBucket() uses for the year view: never a
 *  judgment call handed to the model. Null in, null out. */
export function bucketVix(value, thresholds = {}) {
  if (value == null || !Number.isFinite(value)) return null;
  const calm = thresholds.calm ?? 15;
  const normal = thresholds.normal ?? 20;
  const jumpy = thresholds.jumpy ?? 30;
  if (value < calm) return "calm";
  if (value < normal) return "normal";
  if (value < jumpy) return "jumpy";
  return "volatile";
}

// ---------------------------------------------------------------- network

async function fetchFeed(feed, timeoutMs) {
  try {
    const res = await axios.get(feed.url, {
      timeout: timeoutMs,
      responseType: "text",
      // Several finance RSS hosts 403 a bare Node/axios user-agent.
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-secretary/1.0; +https://github.com)" },
    });
    return { ok: true, name: feed.name, items: parseRssFeed(res.data, feed.name) };
  } catch (err) {
    const reason = err.response ? `HTTP ${err.response.status}` : err.message;
    log.warn(`feed "${feed.name}" failed: ${reason}`);
    return { ok: false, name: feed.name, error: reason };
  }
}

async function fetchIndices(cfg) {
  const list = cfg.indices?.length ? cfg.indices : DEFAULT_INDICES;
  const vixSymbol = cfg.vixSymbol || DEFAULT_VIX_SYMBOL;
  const quotes = new Map();
  try {
    const res = await yahoo.quote([...list.map((i) => i.symbol), vixSymbol]);
    for (const q of Array.isArray(res) ? res : [res]) if (q?.symbol) quotes.set(q.symbol, q);
  } catch (err) {
    log.warn(`index/VIX quote batch failed: ${err.message}`);
  }

  const indices = list.map(({ symbol, label }) => ({
    symbol,
    label,
    pct: quotes.get(symbol)?.regularMarketChangePercent ?? null,
  }));

  const vixPrice = quotes.get(vixSymbol)?.regularMarketPrice ?? null;
  const vix = vixPrice != null ? { value: vixPrice, bucket: bucketVix(vixPrice, cfg.vixThresholds) } : null;

  return { indices, vix };
}

// ------------------------------------------------------------------- main

export async function collectMarketNews(config, { force = false } = {}) {
  const cfg = config.marketNews || {};
  if (cfg.enabled === false) return [];

  const feeds = cfg.feeds?.length ? cfg.feeds : DEFAULT_FEEDS;
  const timeoutMs = cfg.feedTimeoutMs ?? 7000;
  const headlineCount = cfg.headlineCount ?? 6;

  const [feedResults, { indices, vix }] = await Promise.all([
    Promise.all(feeds.map((f) => fetchFeed(f, timeoutMs))),
    fetchIndices(cfg),
  ]);

  const feedErrors = feedResults.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error }));
  const headlines = dedupeHeadlines(
    feedResults.filter((r) => r.ok).flatMap((r) => r.items),
    headlineCount
  );

  // Every feed dead AND no index data either — a genuine failure, counted
  // like any other source error (see lastError_marketNews in the sources
  // panel). A single dead feed among healthy ones is not this; that's just
  // named in feedErrors above and the page still shows real data.
  if (feeds.length && feedErrors.length === feeds.length && !indices.some((i) => i.pct != null) && !vix) {
    throw new Error(`all ${feeds.length} market news feed(s) failed and no index/VIX data came back`);
  }

  const pulse = { at: new Date().toISOString(), indices, vix, headlines, feedErrors };

  const previous = await getMeta("marketPulse", null);
  const take = await getMarketTake(config, pulse, { previous, force });
  await setMeta("marketPulse", { ...pulse, take: take?.text ?? null, takeAt: take?.at ?? null });

  log.info(
    `${headlines.length} headline(s) from ${feeds.length - feedErrors.length}/${feeds.length} feed(s)` +
    (vix ? `, VIX ${vix.value.toFixed(1)} (${vix.bucket})` : "") +
    (feedErrors.length ? ` · dead: ${feedErrors.map((f) => f.name).join(", ")}` : "")
  );

  return [];
}
