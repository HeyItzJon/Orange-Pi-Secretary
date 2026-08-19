# Pi Secretary — Starter Framework

A small, modular framework for an AI-powered dashboard: a backend that reads
data sources on a schedule and asks an AI for insights, and a React frontend
with switchable "pages" (Briefing, Investments) that displays them.

Right now everything runs on **mock data** so you can see the whole pipeline
work for free before connecting anything real (your Obsidian vault, a real
AI provider, real market data).

## How the pieces fit together

```
backend/                    <- Node.js server (runs on your computer, later on the Pi)
  config.json                <- THE FILE YOU'LL EDIT MOST. Change AI provider,
                                 focus areas, how often it runs, prompt text.
  .env                        <- API keys (you create this, never commit it)
  modules/
    vaultAnalyzer.js          <- reads your Obsidian vault (currently mock data)
    marketData.js             <- reads portfolio/news (currently mock data)
    aiClient.js                <- talks to DeepSeek/Claude/mock — swap providers here
    pipeline.js                <- combines the above, saves data/insights.json
    scheduler.js                <- runs pipeline.js on a timer (default: every 2h)
  data/insights.json           <- the AI's latest output (this is what the frontend reads)
  server.js                    <- Express server: API + serves the built frontend

frontend/                    <- React app (built with Vite)
  src/App.jsx                  <- page switching lives here (add new pages in one line)
  src/components/
    BriefingPage.jsx            <- shows AI insights
    InvestmentsPage.jsx          <- shows portfolio + news
    InsightCard.jsx, Header.jsx  <- reusable pieces
```

**Why nothing crashes on page load:** the AI and data calls only happen
inside `scheduler.js`, on a timer. The browser never triggers them — it just
reads whatever `pipeline.js` last saved to `data/insights.json`. This is the
fix for the ticker-query crashes you were hitting before.

## Part 1 — Run it locally on your computer (do this first)

You need [Node.js](https://nodejs.org) installed (the LTS version, 18 or newer).
Check with:
```bash
node -v
```

**Start the backend** (in one terminal window):
```bash
cd backend
npm install
npm start
```
You should see:
```
[server] Running at http://localhost:3001
[scheduler] Pipeline will run every 2 hour(s).
[pipeline] Running with provider "mock"...
[pipeline] Saved 4 insights.
```
That last line means it worked — mock data flowed all the way through.

**Start the frontend** (in a second terminal window, don't close the first):
```bash
cd frontend
npm install
npm run dev
```
It will print a local URL, usually `http://localhost:5173`. Open that in
your browser. You should see the dashboard with two tabs: **Briefing** and
**Investments**, both showing mock data.

While `npm run dev` is running, any change you make to a `.jsx` or `.css`
file appears in the browser instantly — no restart needed. That's your
edit-and-see-it loop for the frontend.

For the backend, if you used `npm start`, you need to stop it (Ctrl+C) and
run `npm start` again after editing a `.js` file. Or use `npm run dev`
instead of `npm start` in the backend folder too — it auto-restarts on save.

## Part 2 — Tweak how it thinks

Open `backend/config.json`. This is plain text, no code. Things you can
change immediately:

- `"analysisFocus"` — remove a category you don't care about, e.g. delete `"patterns"`
- `"insightCount"` — how many insights to generate
- `"systemPrompt"` — the instructions the AI follows. Rewrite this in your
  own words to change its "personality" or priorities.
- `"schedule.intervalHours"` — how often the pipeline runs

After changing `config.json`, either wait for the next scheduled run, or
force it immediately:
```bash
curl -X POST http://localhost:3001/api/refresh
```
(There's also a "Run pipeline now" button in the UI if the briefing is empty.)

## Part 3 — Connect a real AI provider (when you're ready)

1. Copy `backend/.env.example` to `backend/.env`
2. Add your API key (DeepSeek or Anthropic) to that file
3. In `config.json`, change `"aiProvider"` from `"mock"` to `"deepseek"` or `"claude"`
4. Restart the backend

Nothing else changes — `aiClient.js` handles the swap internally. This is
what "modular" means in practice: one line in a config file, not a code rewrite.

## Part 4 — Connect your real Obsidian vault (when you're ready)

Right now `backend/modules/vaultAnalyzer.js` returns fake data shaped like a
real vault scan. Once Syncthing has your vault mirrored onto the Pi (or
even just onto this computer for testing), we'll rewrite the inside of
that one function to actually read files. Nothing else in the project needs
to change — every other module just consumes whatever `vaultAnalyzer.js`
returns.

Same idea for `backend/modules/marketData.js` when you're ready for real
tickers/news — we'll swap the inside for a real API call with proper
fallback handling, one ticker at a time, so it never crashes the way it did
in Claude.

## Part 5 — Move it to the Orange Pi (later, once this feels solid)

Rough shape of what that'll look like (we'll go step by step when you're there):
```bash
# Build the frontend once, ahead of time:
cd frontend && npm run build

# Copy the whole project to the Pi:
scp -r pi-secretary/ pi@<pi-ip-address>:/home/pi/

# On the Pi, install Node, then:
cd pi-secretary/backend
npm install
npm start

# Point the kiosk browser at:
http://localhost:3001
```
We'll refine this once we're actually on the Pi — this is just the shape of
it so nothing here feels mysterious later.

## Adding a new "page" later

1. Create a new component in `frontend/src/components/`
2. Add `{ id: "yourpage", label: "Your Page" }` to the `PAGES` array in `App.jsx`
3. Add one line rendering it in the `<main>` section of `App.jsx`

That's the whole framework — this is designed so almost everything you'll
want to change lives in `config.json` or one clearly-named file, not
scattered across the codebase.
