# What to connect next — a pitch

**19 Aug 2026.** Researched for feasibility, not vibes. Every item below has a
verdict and an effort estimate. Nothing here needs a paid API key.

The organising idea: **each integration should feed a lane you already have.**
If it doesn't obviously belong in School, Work, Career, Finance, Social,
Projects or Personal, it probably doesn't belong.

---

## The gap, stated plainly

Right now the system knows what's on your *calendar* and in your *inbox*. That
means it knows about a deadline only if a professor put it in Brightspace's
calendar field, or emailed you about it, or you typed it into Google Calendar
yourself.

**The School lane is the thinnest lane you have, and it's the one that matters
most this term.** Two of the four Tier 1 items below exist to fix that.

The second gap is that the brief only exists where the laptop is. It should
reach your phone.

---

## Tier 1 — build these. ~7 hours total, $0/month.

### 1. Push notifications via ntfy.sh → *everywhere* · **30 min**

The single best ratio on this list. Pick a long random topic name, install the
app, and `POST` to `https://ntfy.sh/<topic>`. No account, no key, no inbound
firewall rule — it's an outbound HTTPS POST from Node.

Free tier is unlimited for our volume. Migrating to self-hosted later is a
base-URL change, nothing more.

**The catch:** the topic name *is* the password. Use something long.

Once this exists the morning brief stops being a thing you remember to open.

### 2. Brightspace calendar feed → *School* · **2–3 hours**

Both uOttawa and Carleton run **D2L Brightspace** in 2026. Brightspace has a
**Calendar → Subscribe** button that gives you a personal `.ics` URL covering
**all enrolled courses at once** — assignment due dates, quiz windows, content
module deadlines. Zero auth code: fetch the URL on a timer, parse with
`node-ical`, emit items. Reuses everything the calendar source already does.

**Do this by hand before I write a line of code:** open Brightspace → Calendar →
Subscribe, and tell me whether the button is there. `Enable Calendar Feeds` is
an institutional admin toggle, and I cannot check it remotely. It's a
30-second click and it's the go/no-go for the whole item.

**The honest caveat:** the feed only contains what instructors actually typed
into the date field. Plenty of profs put deadlines only in the syllabus PDF.
Expect maybe half your real deadlines. Which is why the next item exists.

### 3. Canada Holidays + market-open awareness → *Personal, Finance* · **1 hour**

`canada-holidays.ca/api` — free, keyless, province-filterable. Two uses:

- City of Ottawa rec facilities run holiday hours and stat pay differs — worth
  flagging on a shift.
- **TSX and NYSE holidays don't line up.** Family Day and Victoria Day vs. MLK
  and Juneteenth. Without this, the dashboard shows Friday's close as though
  it were today's price on a Canadian holiday — which quietly undermines
  every other number on the screen.

### 4. Bank of Canada FX → *Finance* · **1 hour**

`bankofcanada.ca/valet` — no registration, no key, official daily USD/CAD.

You hold TSX and US names. **Your US holdings' CAD value moves on FX as much
as on price**, and the dashboard currently doesn't show that at all. This is
the most under-served number you have.

### 5. Real market news via RSS → *Finance* · **2 hours**

The fabricated headlines are gone but nothing replaced them. Globe & Mail
Report on Business, Financial Post, BNN Bloomberg and Reuters Canada all
publish RSS. `rss-parser`, filter for your tickers' names, done.

**No API key, no rate limit, no model anywhere near it** — which matters given
how this project's last brush with generated market commentary went. Real
headlines or none.

---

## Tier 2 — genuinely good, more work

### 6. Syllabus → deadlines → *School* · **4–6 hours**

Drop a syllabus PDF in a watched folder; extract every deadline into items.

There is **no library for this** — the GitHub results are all dead hackathon
projects. But the stack is short: `pdfjs-dist` for text (better than
`pdf-parse` because it keeps line positions, and syllabi put deadlines in
tables), then the model with a structured-output schema, with `chrono-node` as
a deterministic check on relative dates like "the Friday before reading week".

**Non-negotiable: a review table before anything becomes a reminder.** You
accept or reject each extracted date. Run it once per term, not on a cron —
and when it disagrees with Brightspace, Brightspace wins.

Five courses, ~10 minutes of review, once every four months. Worth it.

### 7. Weather that only speaks when it matters → *Personal* · **2 hours**

**Open-Meteo**, not OpenWeatherMap. No API key at all for non-commercial use,
10,000 calls/day free, 15-minute precipitation resolution. OpenWeatherMap now
puts the endpoint you'd actually want behind a billing setup — no reason to
attach a card for something Open-Meteo gives away.

The rule: check precipitation **only across your commute window**, and say
nothing otherwise. "Rain 4–6 PM, you're biking home at 5."

Add **ECCC alert feeds** (CAP XML, free) for the Ottawa-specific signal that
actually changes behaviour: extreme cold warnings, winter storm warnings,
summer AQHI on wildfire-smoke days. Open-Meteo won't give you those.

### 8. OC Transpo next departures → *Personal* · **3–4 hours**

GTFS-Realtime on Azure API Management — free, sign up for a key, `TripUpdates`
in JSON (skip protobuf entirely). "Next 3 departures at your stop" is
straightforward.

**"Leave in 12 minutes" is a much bigger job** (+6–8h): it needs GTFS static in
SQLite plus walking times. Do **not** stand up a routing engine — you have
maybe three regular origin/destination pairs. Hardcode the walk legs as
constants. Thirty minutes of work, perfectly accurate, and it can't break.

Two flags: the endpoint has been labelled `beta` since 2024, and the rate
limits aren't published (they're behind portal sign-in). Keep the legacy API
as a fallback.

### 9. Earnings and ex-dividend dates → *Finance* · **3–4 hours**

Here's the thing nobody tells you: **the free tiers of Finnhub, FMP and Alpha
Vantage are all effectively US-only.** FMP wants $59/mo for Canadian coverage.
For a portfolio that's half TSX, that's disqualifying.

The answer is the library you already use: `yahoo-finance2`'s
`quoteSummary(symbol, {modules:['calendarEvents']})` returns `earningsDate` and
`exDividendDate`, and it covers `.TO` tickers.

**It's unofficial and Yahoo has broken it before** (April 2024, cookie/crumb
change). So: cache last-known-good dates to disk, wrap every call, and degrade
to "as of <date>" rather than showing a stale number as fresh.

### 10. TFSA / RRSP room, self-tracked → *Finance* · **2 hours**

**There is no CRA API.** Confirmed — My Account is a portal, and the only
machine-readable channel (Auto-fill my return) is restricted to EFILE-certified
tax software vendors. Don't scrape it; automating a government tax login is a
bad trade at any odds.

The good news is it's deterministic. Enter your room once each spring from the
Notice of Assessment, then decrement it from contributions you log, and warn
on over-contribution. **This is better than an API would be**, because it's
forward-looking rather than a stale January snapshot. Label it "self-tracked,
last reconciled <date>" so you never mistake it for CRA's number.

### 11. Ottawa winter parking ban → *Personal* · **2 hours, Nov–Apr only**

Highest "saved me a real ticket" score on the list. There's no JSON API — bans
are newsroom posts, so this one is **scraping**, and fragile by nature. Make it
fail quiet: never assert "no ban," only "ban in effect." Pair it with the ECCC
snowfall warning as a second signal.

### 12. Telegram, two-way → *everywhere* · **3 hours**

Once notifications exist, a Telegram bot adds a *reply* channel: "snooze 30m",
"what's due this week", "log 2h shift", "append to today's note". Outbound long-
polling, so it works behind NAT with no port forwarding.

This is the item that matters most **once the Pi goes headless** — it turns the
dashboard from something you look at into something you can reach.

---

## Tier 3 — tempting, don't

| Thing | Why not |
|---|---|
| **Brightspace / Valence API** | App registration is an institutional-admin function. A student cannot self-register an OAuth client. You'd be asking uOttawa IT to provision a third-party app for your personal dashboard. |
| **Canvas LMS** | Neither school uses it. Irrelevant. |
| **Finnhub / FMP / Alpha Vantage paid** | You'd be paying $59/mo to get Canadian coverage that Yahoo gives you free. |
| **CRA API** | Doesn't exist. See #10. |
| **OpenWeatherMap** | Requires billing setup for the useful endpoint. Open-Meteo is free and better. |
| **Gotify** | Android-only, needs a server you expose. Strictly worse than ntfy. |
| **SEDAR+ filings** | No public API, unlike SEC EDGAR. US holdings only, if ever. |
| **OpenTripPlanner** | A routing engine on a 1–4 GB Orange Pi to solve three fixed walking routes. No. |
| **City of Ottawa staff scheduling** | Behind an internal system. A photo of the schedule → model → calendar is the honest answer, and it reuses the syllabus parser. |

---

## What I'd actually do, in order

**This week (~4 hours), in this order:**

1. **ntfy** (30 min) — because everything after this is worth more once the
   brief reaches your phone.
2. **Canada Holidays + market-open** (1h) — small, and it stops a class of
   quietly-wrong numbers.
3. **BoC FX** (1h) — the biggest missing number in Finance.
4. **RSS market news** (2h) — finally replaces what `marketContext.js` was
   faking.

**Then, once you've clicked Subscribe in Brightspace and told me what you see:**

5. **Brightspace ICS** (2–3h) — this is the one that changes the School lane
   from thin to real.
6. **Syllabus parsing** (4–6h) — covers what Brightspace misses.

**Before winter:** Open-Meteo + ECCC alerts, then the parking ban scraper.

**When the Pi goes headless:** Telegram two-way.

---

## The one thing I need from you

**Open Brightspace → Calendar → Subscribe. Is the button there?**

Everything about the School lane hinges on that, it takes thirty seconds, and
it's the only thing on this list I couldn't determine from here.

---

## Flagged as unverified

Things I'd confirm with one HTTP request before writing code against them:

- OC Transpo GTFS-RT rate limits (behind portal sign-in, not published)
- Ottawa's ECCC citypage site code (probably `s0000430`)
- The exact Bank of Canada series name (probably `FXUSDCAD` — query
  `/valet/lists/series` first)
- Whether uOttawa/Carleton offer a course-timetable ICS export
