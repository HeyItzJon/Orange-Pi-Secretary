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

```bash
cd backend
npm install
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
calendar ─┐
inbox ────┤                                        ┌─ Today
money ────┼─→ items (stable id, memory) ─→ rules ──┼─ Needs you
notes ────┘                                        ├─ New since yesterday
                                                   ├─ Coming up
                                                   ├─ Money
                                                   └─ Loose threads
```

Every item lands in **exactly one** section, so nothing is ever said twice in
the same brief. Empty sections are hidden. A short brief is the system
working.

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

1. Gmail message ids are immutable, so already-seen ids are dropped before
   anything is fetched. Most runs stop here.
2. Messages are fetched with `format=metadata` and a header whitelist, not
   `format=full`.
3. Newsletters (`List-Unsubscribe`), muted senders and anything that doesn't
   match your rules are dropped — no tokens spent.
4. Survivors go to the model in ONE call, cached by content hash.
5. Calendar, money and notes never call the model at all.

A quiet morning costs one Gmail list call and nothing else.
Watch it at `GET /api/usage`.

Set `ai.provider` to `"off"` in `config.json` to run the whole system with
zero AI calls. The brief still renders; it just has no summary line.

---

## Configuration

Everything worth tuning is in `backend/config.json`.

- **`rules`** — who and what matters. Priority order is opportunities, then
  work and family, then school. Add a name to `rules.people` or a domain to
  `rules.domains` and it outranks everything generic. This is the single
  biggest lever on output quality.
- **`email.minScore`** — the bar an email must clear to reach the model.
  Lower to widen the net, raise it to spend less.
- **`brief.maxRepeats`** — how many times an unchanged, undated item is
  allowed to speak before going quiet.
- **`calendar.targets`** — must match Google exactly. Curly apostrophes and
  `&` are normalised automatically, so `Sydney's Demands` resolves either way.
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
node scripts/test-rules.js
```

Covers the clock, suppression, newness, section assignment, and the email
triage rules. The rules engine is pure, so it tests without touching Gmail,
the model, or the system clock.

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

One JSON file at `backend/data/secretary.json`, written atomically
(temp + rename, so a power cut can't corrupt it) behind an in-process mutex.
That mutex is the fix for v1's bug where the scheduler and a manual refresh
would overwrite each other.

Single user, a few thousand items over years — a JSON file is the right tool.
If it ever outgrows that, swap `lib/store.js` for `node:sqlite`; nothing else
in the codebase knows how storage works.
