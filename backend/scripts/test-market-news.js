// scripts/test-market-news.js — the pure RSS-parsing/bucketing math behind
// the Finances page's market panel. No network calls here; the real feed
// fetch and Yahoo index pull (collectMarketNews) and the once-a-day AI
// sentence (getMarketTake) are exercised manually via
// `npm run refresh-market-news` against real data instead — same
// convention scripts/test-stock-ideas.js already uses for its own network
// half.
//
// Run: node scripts/test-market-news.js

import assert from "node:assert/strict";
import { parseRssFeed, decodeEntities, dedupeHeadlines, bucketVix } from "../sources/marketNews.js";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

// ====================================================================
group("parseRssFeed — real RSS 2.0 shape");

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Example Markets</title>
<item>
  <title><![CDATA[Stocks rise as rate jitters ease]]></title>
  <link>https://example.com/a</link>
  <pubDate>Mon, 24 Aug 2026 12:30:00 GMT</pubDate>
</item>
<item>
  <title>Fed &amp; markets: what to watch this week</title>
  <link>https://example.com/b</link>
  <pubDate>Mon, 24 Aug 2026 09:00:00 GMT</pubDate>
</item>
</channel></rss>`;

test("extracts title, link, and an ISO pubDate from each <item>", () => {
  const items = parseRssFeed(RSS_SAMPLE, "Example");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Stocks rise as rate jitters ease");
  assert.equal(items[0].link, "https://example.com/a");
  assert.equal(items[0].publishedAt, new Date("Mon, 24 Aug 2026 12:30:00 GMT").toISOString());
  assert.equal(items[0].source, "Example");
});

test("CDATA is unwrapped and HTML entities are decoded", () => {
  const items = parseRssFeed(RSS_SAMPLE, "Example");
  assert.equal(items[1].title, "Fed & markets: what to watch this week");
});

test("a feed with no <item> or <entry> blocks at all returns an empty list, not a crash", () => {
  assert.deepEqual(parseRssFeed("<rss><channel><title>Empty</title></channel></rss>", "Example"), []);
  assert.deepEqual(parseRssFeed(""), []);
  assert.deepEqual(parseRssFeed(null), []);
});

test("an <item> with no title is dropped rather than producing a blank headline", () => {
  const xml = `<rss><channel><item><link>https://example.com/c</link></item></channel></rss>`;
  assert.deepEqual(parseRssFeed(xml), []);
});

// ====================================================================
group("parseRssFeed — Atom fallback");

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Markets close mixed</title>
  <link href="https://example.com/atom-a" rel="alternate"/>
  <updated>2026-08-24T20:00:00Z</updated>
</entry>
</feed>`;

test("an Atom feed's <entry>/href link and <updated> date are read the same as RSS", () => {
  const items = parseRssFeed(ATOM_SAMPLE, "AtomFeed");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Markets close mixed");
  assert.equal(items[0].link, "https://example.com/atom-a");
  assert.equal(items[0].publishedAt, "2026-08-24T20:00:00.000Z");
});

// ====================================================================
group("decodeEntities");

test("common named entities and numeric entities both decode", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeEntities("caf&#233;"), "café");
  assert.equal(decodeEntities("caf&#xe9;"), "café");
});

test("an unknown entity is left as-is rather than mangled", () => {
  assert.equal(decodeEntities("A&weirdentity;B"), "A&weirdentity;B");
});

// ====================================================================
group("dedupeHeadlines — same wire story from two feeds shouldn't show twice");

test("near-identical titles (case/punctuation aside) collapse to one, newest first", () => {
  const list = [
    { title: "Stocks rise on rate cut hopes", publishedAt: "2026-08-24T09:00:00Z", source: "A" },
    { title: "Stocks Rise On Rate-Cut Hopes!", publishedAt: "2026-08-24T12:00:00Z", source: "B" },
    { title: "Oil slips as demand outlook softens", publishedAt: "2026-08-24T08:00:00Z", source: "A" },
  ];
  const out = dedupeHeadlines(list, 10);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "B"); // the newer of the two duplicate wordings survives
  assert.equal(out[1].title, "Oil slips as demand outlook softens");
});

test("caps to the requested count", () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ title: `Story ${i}`, publishedAt: `2026-08-24T0${i}:00:00Z` }));
  assert.equal(dedupeHeadlines(list, 3).length, 3);
});

test("an empty or missing list is handled without throwing", () => {
  assert.deepEqual(dedupeHeadlines([], 5), []);
  assert.deepEqual(dedupeHeadlines(undefined, 5), []);
});

// ====================================================================
group("bucketVix — rule-based, not a model guess");

test("default thresholds: calm under 15, normal under 20, jumpy under 30, volatile at or above", () => {
  assert.equal(bucketVix(12), "calm");
  assert.equal(bucketVix(14.99), "calm");
  assert.equal(bucketVix(15), "normal");
  assert.equal(bucketVix(19.9), "normal");
  assert.equal(bucketVix(20), "jumpy");
  assert.equal(bucketVix(29.9), "jumpy");
  assert.equal(bucketVix(30), "volatile");
  assert.equal(bucketVix(45), "volatile");
});

test("custom thresholds from config are honored", () => {
  assert.equal(bucketVix(18, { calm: 10, normal: 20, jumpy: 30 }), "normal");
});

test("null/undefined/non-finite input returns null rather than a wrong bucket", () => {
  assert.equal(bucketVix(null), null);
  assert.equal(bucketVix(undefined), null);
  assert.equal(bucketVix(NaN), null);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
