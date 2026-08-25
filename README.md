# Pi Secretary v2

A morning brief that earns its place.

Reads your calendar, inbox, portfolio and Obsidian vault, and tells you what
you need to know today — then shuts up about it until something changes.

**Rules decide what surfaces. The model only writes it up.**

---

## What changed from v1

v1 regenerated "insights" from scratch every two hours. It had no memory, so
it could never say what was *new* and never stopped repeating itself; and it
asked the model to decide what mattered, which it couldn't know.

v2 keeps a store of **items** with stable ids, so it knows what it has
already told you and how many times. What gets shown is decided by rules you
can read and tune in `config.json`.

v1's market intelligence (`marketContext.js`) returned hardcoded strings —
a fixed Fed rate, invented sector performance, invented geopolitical risks —
and fed them to the model under the heading "Market Reality". That module is
gone. Nothing in v2 invents a fact.

---

## Getting started

Requires **Node 22+** (storage uses `node:sqlite`, built in from that
version on — no separate database install, no native module to compile).

```bash
cd backend
npm install
cp config.example.json config.json   # then edit config.json — see Configuration
cp .env.example .env                 # then add your API keys
npm run doctor      # checks credentials, calendars, vault, portfolio
npm run brief:dry   # full run with NO AI calls — good first test
npm run brief       # full run with narration
npm start           # server + scheduler on :3001
```

```bash
cd frontend
npm install
npm run build       # REQUIRED — the server serves frontend/dist
```

`npm run doctor` is the first thing to run whenever something looks wrong.
It tells you in plain language which credential is missing, which calendar
name doesn't match Google, and whether the frontend is built.

---

## How a brief is assembled

```
                                                   ┌─ Today ── a timeline of
calendar ─┐                                        │           the whole day,
inbox ────┤                                        │           domains mixed
money ────┼─→ items (stable id, memory) ─→ rules ──┤           and tagged
notes ────┘                                        │
                                                   └─ Lanes ── School · Work
                                                               Career · Finance
                                                               Social · Projects
                                                               Personal
```

**Today** is chronological and mixes everything, because that's the shape of a
day: you work 12–5 *and* there's a barbecue at 7. **Lanes** hold everything
that isn't today, grouped by where your attention goes.

Every item lands in **exactly one** place. "New" and "needs action" are flags
plus a filter bar, not sections, so nothing is ever duplicated. Empty lanes are
hidden — a short brief is the system working.

### Domains vs. categories

Two orthogonal axes, and the distinction matters:

- **Category** = what kind of thing it is (Test, Class, Shift, Appointment).
  Drives the tag and the ranking weight.
- **Domain** = which lane of your life it belongs to. Drives *where it goes*.

`CANNOT MISS` tells you how much something matters, not whether it's a final
exam or a friend's wedding — so importance categories are deliberately excluded
from the category→domain map and can never decide a lane. A can't-miss wedding
lands in **Social**; a can't-miss exam lands in **School**.

### Categories

Every item is given a category — Class, Test, Work, Can't miss, Opportunity,
Appointment, Deadline, Admin, Family, Personal — and it shows as a tag on the
row. Categories come from `config.json`, never from code: no calendar name and
no person's name appears in a source file.

Three signals decide it:

1. **Calendar name patterns** — you already organise by calendar, so that IS
   your categorisation. `calendarPatterns` matches it loosely.
2. **Title patterns** — `titlePatterns` matches the event title or email subject.
3. **Structure** — a course-code shape (`MSE 3401`, `PHYS1010`) means Class
   without any keyword at all.

Every definition that matches is collected and the **heaviest weight wins**, so
an exam on the "School & Classes" calendar is a Test, not a Class.

Two conventions of yours are read directly:

- **ALL CAPS means it matters.** A title that's ≥70% uppercase and longer than
  three letters gets an emphasis boost, and is never suppressed. "PHYSIO" is
  emphasis; "MSE 3401 lecture" is not, because the ratio test ignores acronyms.
- **A calendar named like an email address is not a label.** The default
  calendar's name is your address, so it's never printed — the category tag
  replaces it.

### Ranking

One number per item, assembled from parts:

```
category weight  (24–50, from config)
+ urgency         steep curve: 38 today, 26 at 2 days, 4 at 10, 1 beyond
+ needs a reply   +12
+ overlapping     +14
+ you capitalised it  +15
+ can't-miss category +10
+ changed         +6
- repetition      up to -8, but only when nothing is close
```

The components are recorded on every item as `_rankWhy` and shown when you
hover the row, so the order always explains itself. Some consequences worth
knowing: a test in two days beats an opportunity in twelve, the same
opportunity wins once it's the closer one, and something you wrote in caps
beats a routine class at the same hour.

`Today` is the exception — it reads chronologically, because it's a schedule,
not a ranking.

### The memory model

Each item carries `firstSeen`, `surfaceCount`, `contentHash` and `status`.
That's what makes the useful behaviours possible:

| Behaviour | Mechanism |
|---|---|
| "New since yesterday" | `firstSeen` is after the last brief |
| Stops repeating | `surfaceCount` past `maxRepeats`, unchanged, no deadline |
| Escalates | urgency derived from `dueAt` — quiet at 10 days, loud at 1 |
| Detects a change | `contentHash` differs → resurfaces as CHANGED |
| "I know, stop" | `status` set to done / dismissed / snoozed |

Anything with a deadline running is **never** suppressed, however often
you've been told.

---

## API budget

The model is called for exactly two things: classifying the handful of emails
that already passed your rules (one batched call), and writing one summary
line. Everything else is deterministic.

Cost control, in the order it happens:

1. One cheap id-list call.
2. **Boost queries** — one extra id-list call per tier, run by Gmail as a
   full-text search. This is how mail that mentions your workplace deep in the
   body, or is signed by a colleague at the bottom, gets caught **without
   downloading a single message**. It also rescues important mail that fell
   past the main list's cap.
3. Gmail message ids are immutable, so already-seen ids are dropped before
   anything is fetched. Most runs stop here.
4. Messages are fetched with `format=metadata` and a header whitelist, not
   `format=full`.
5. Newsletters (`List-Unsubscribe`), muted senders and anything that doesn't
   match your rules are dropped — no tokens spent.
6. Survivors go to the model in ONE call, cached by content hash.
7. Calendar, money and notes never call the model at all.

A quiet morning costs three list calls and nothing else.
Watch it at `GET /api/usage`.

Only **distinctive** terms are ever body-searched — a multi-word phrase, or a
single word of 7+ characters. Body-searching "mom" or "job" would return half
the inbox, so those stay header-only. Opt a rule in with `"searchBody": true`,
and use `bodyKeywords` to hand-pick a narrower list than the header keywords:

```json
"work": {
  "searchBody": true,
  "keywords":     ["shift", "facility", "supervisor", "<workplace>", ...],
  "bodyKeywords": ["<workplace>", "recreation complex", "timesheet", ...]
}
```

Set `ai.provider` to `"off"` in `config.json` to run the whole system with
zero AI calls. The brief still renders; it just has no summary line.

---

## What stays on your machine

This repo is safe to make public. Everything personal is gitignored and never
committed:

| Not committed | Why |
|---|---|
| `backend/.env` | API keys, Google OAuth client secret and refresh token |
| `backend/client_secret.json` | Google OAuth credentials |
| `backend/config.json` | your real names, calendars, vault path |
| `backend/config/portfolio.json` | your holdings and share counts |
| `backend/data/` | the item store — actual emails, events, prices |

What IS committed is `config.example.json` — the same structure with
placeholder names. Copy it to `config.json` and edit that. If you ever need to
check before pushing, `git status --ignored` shows you exactly what's excluded.

---

## Configuration

Everything worth tuning is in `backend/config.json`
(start from `config.example.json`).

- **`rules`** — who and what matters. Priority order is opportunities, then
  work and family, then school. Add a name to `rules.people` or a domain to
  `rules.domains` and it outranks everything generic. This is the single
  biggest lever on output quality.
- **`categories.definitions`** — what kind of thing something is, and how much
  each kind weighs. Adding a category is a config edit, not a code change.
- **`ranking`** — the boosts. Turn `emphasisBoost` down if caps shouldn't
  matter as much, or `maxFatiguePenalty` up if repeats should sink faster.
- **`email.minScore`** — the bar an email must clear to reach the model.
  Lower to widen the net, raise it to spend less.
- **`brief.maxRepeats`** — how many times an unchanged, undated item is
  allowed to speak before going quiet.
- **`calendar.targets`** — must match Google exactly. Curly apostrophes and
  `&` are normalised automatically, so `Family Events` resolves either way.
  `npm run doctor` prints what Google actually returns.
- **`money`** — thresholds. Nothing is surfaced unless one fires.
- **`notes.watchFolders`** — which vault folders to watch for loose threads.

---

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/brief` | the current brief |
| GET | `/api/items` | everything the system knows (`?status=open`) |
| GET | `/api/usage` | token spend, by day |
| GET | `/api/health` | liveness |
| POST | `/api/refresh` | all sources, then compose |
| POST | `/api/refresh/:source` | `email` · `calendar` · `money` · `notes` |
| POST | `/api/brief/rebuild` | recompose from memory — no API calls |
| POST | `/api/items/:id/done` | never show again |
| POST | `/api/items/:id/dismiss` | same, but "not relevant" |
| POST | `/api/items/:id/snooze` | body `{days: 3}` |
| POST | `/api/items/:id/reopen` | undo |

---

## Schedule

| | |
|---|---|
| Calendar + email pull | 06:30, 12:30, 18:30 |
| Notes | 06:20 |
| Money | 17:15 (after close) |
| Brief composed | 06:40 |

Times are local to `config.timezone`, checked once a minute. No cron
dependency.

---

## Tests

```bash
npm test
```

Runs every suite in one go:

| File | Covers |
|---|---|
| `test-rules.js` | the clock, suppression, newness, section assignment, email triage rules |
| `test-display.js` | the always-on screen's data shaping — Today / Week / Tasks / Finances / Year pages |
| `test-money.js` | currency conversion and portfolio valuation math |
| `test-priorities.js` | AI pick matching against candidates, undated-item staleness |
| `test-year.js` | the year grid's day-by-day coloring |
| `test-store.js` | the SQLite store — item lifecycle, prune rules, message-id dedup, ai cache, portfolio/holding history, holdings |
| `test-stock-ideas.js` | the "worth a look" ranking math — sector bucketing, sector-weight aggregation, similarity-vs-concentration scoring |
| `test-time.js` | the calendar-day math behind every "refresh once a day" cache — specifically that it's midnight-based, not a rolling 24-hour TTL |

All of them are pure — no live Gmail, Google, Yahoo, or AI calls happen while
testing. `test-store.js` in particular runs entirely against a throwaway
temp-file database (set via `STORE_DB_PATH`), created fresh and deleted after
the run — it never touches your real `secretary.db`. Safe to run any time,
including right before you deploy something that touches storage.

**Exercising it against real data, without waiting for the scheduler:**

```bash
npm run brief:dry                       # every source, composed, zero AI calls
npm run brief                           # same, with AI
node scripts/run-once.js --only=money   # just one source — email, calendar, or money
```

**Forcing a holdings resync**, e.g. right after editing a `type: holding`
note in the vault and not wanting to wait for the next scheduled refresh:

```bash
npm run sync-holdings
```

Prints every ticker it found and where it came from — `vault` on a real
sync, `cache` if the TTL hadn't expired yet (in which case run it with the
vault definitely reachable, or just wait — it's not stuck, it's working as
designed), or `config/portfolio.json` as the last-resort fallback.

**Forcing a stock-idea refresh**, same idea, for the "worth a look" spot on
the money page (below the up/down movers):

```bash
npm run refresh-stock-idea
```

Needs a synced `holdings` table (`npm run sync-holdings` first if you
haven't) and at least one real money pull already done (`npm run brief:dry`
first if `moneySummary` is empty), since the ranking weighs candidates
against your actual sector exposure, not placeholder numbers. Prints the
ranked candidate(s), the sector each fills, and the same "similar to N of
your holdings" reasoning the display shows. This is also the only way to
exercise `lib/stockIdeas.js`'s live Yahoo calls (`recommendationsBySymbol`,
`quoteSummary`, `quote`) end-to-end — `test-stock-ideas.js` only covers the
pure ranking math, since I have no network path to Yahoo from where I do
this work, so run this one yourself to confirm the real API calls behave.

**Checking a fresh SQLite migration.** If you ever need to redo the move
from the old `secretary.json` (a fresh install, a restored backup, testing):

```bash
node scripts/migrate-to-sqlite.js --dry     # prints counts, writes nothing
node scripts/migrate-to-sqlite.js           # migrates for real
```

Every write is an upsert (safe to re-run), the source JSON file is never
touched or deleted, and it refuses to run if `secretary.db` already exists —
move the old one aside first if you're deliberately redoing a migration.

---

## Notes for the Pi

- **Ethernet only.** The Zero 3's WiFi chip (Unisoc UWE5622) has documented
  transmit-queue timeouts and scan failures needing a reboot.
- **No local LLM.** Measured ~1 tok/s for a 1B model and 35–60 s to first
  token. This system calls an API; the Pi is the scheduler, cache and display.
- **The microSD is the only storage and the top failure mode.** Take a `dd`
  image backup — that's the actual recovery plan. A power bank with
  pass-through charging is the best $15 of reliability you can buy, because
  power loss during a write is how these boards usually die.
- Buy 2 GB or 4 GB, never 1.5 GB (U-Boot RAM-probe bug → boot crashes).
- Armbian Debian 13 minimal, kernel 6.18.x. Node arm64 is Tier-1.

---

## Storage

SQLite at `backend/data/secretary.db` (`node:sqlite`, built into Node 22+ —
no extra dependency, no native module to compile). Every write is one
synchronous statement straight against the file, which is why there's no
mutex here anymore: the old JSON-file version needed one because
`readFromDisk`/`writeToDisk` were real async I/O that a second overlapping
call could interleave with. That failure mode can't happen with a
synchronous write against the database itself. WAL journaling covers
power-cut durability; on a filesystem that can't do WAL (some network or
bridged/virtualized mounts can't — you'll see a one-line warning in the
logs if so), it falls back to SQLite's default rollback journal instead of
failing to start.

`lib/store.js` is still the only module that knows any of this — same
contract as always: nothing else in the codebase talks to storage directly.

| Table | What it holds |
|---|---|
| `items` | every item, keyed by id. A `data` column holds the full object as JSON (the source of truth on read); `status`/`source`/`dueAt`/`firstSeen`/`lastSeen` are promoted to indexed columns |
| `seen_message_ids` | Gmail message ids already processed, for dedup |
| `ai_cache` | the classification cache, keyed by content hash |
| `meta` | generic key → JSON value, for anything that's naturally a single blob rather than rows — `moneySummary`, `usage`, `calendarList`, `lastRun_*` / `lastError_*` / `lastAttempt_*`, `holdingsSyncedAt`, `stockIdea`, and so on |
| `holdings` | the current book — one row per ticker (shares, currency, sector, book value, avg cost). Replaced wholesale on every vault sync, so a sold position disappears instead of lingering with stale shares |
| `portfolio_days` | one row per day — the whole portfolio's total, day %, day $. No row cap; kept indefinitely |
| `holding_days` | one row per ticker per day — price and day change. New as of this table's introduction; it only has data from that point forward, nothing was backfilled |

**The holdings cache.** `money.js` used to re-read every `type: holding`
note in the vault on every 15-minute pull. It now reads the local
`holdings` table on every pull, and only re-walks the vault the first time
a pull is checked after local midnight (`config.timezone`) —
`config.money.holdingsRefreshDays` (default 1) tunes that to less than
daily if you want. This is calendar-day math (`lib/time.js`), not a
rolling N-hours-since-last-time clock: a sync at 11:58 PM won't push the
next one out to nearly midnight the *following* day the way a 24-hour TTL
would. If the vault can't be read on a stale check, it falls back to the
last-known cached copy, then to `config/portfolio.json`, in that order.
`npm run sync-holdings` forces an immediate resync outside that schedule —
see **Tests**, above.

**The "worth a look" candidate** (`stockIdea` in `meta`) is a single
current-snapshot blob, not a table — there's nothing to query across rows
for, just "what's the answer right now." Refreshed once a calendar day,
same `lib/time.js` midnight math as the holdings cache above
(`config.money.stockIdeaRefreshDays`, default 1), grounded entirely in real
Yahoo similarity data (`recommendationsBySymbol`) and your real portfolio's
sector weights, never an AI-generated pitch — see `lib/stockIdeas.js` for
why that distinction matters here specifically. `npm run refresh-stock-idea`
forces an immediate refresh — see **Tests**, above.

**Coming from the old JSON file.** If `backend/data/secretary.json` exists
and `secretary.db` doesn't yet, run `node scripts/migrate-to-sqlite.js` —
see **Tests**, above, for the full usage. The JSON file is never modified
by it and is worth keeping around as a backup regardless.

Single user, a few thousand items over years, one machine — SQLite is
comfortably the right tool at this scale, and it's what unlocked storing
per-holding daily history at all: a JSON blob would have made "how did one
ticker move over the last year" an expensive full-file scan instead of an
indexed query.
