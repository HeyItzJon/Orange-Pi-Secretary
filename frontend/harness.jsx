import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import Display from "./src/Display.jsx";
import demo from "./demo.json";

// Serve the model straight from the fixture so the page renders without a backend.
const realFetch = window.fetch;
// Canned answers for the on-demand AI detail modal (ItemDetailModal in
// Display.jsx) — keyed by the demo item's own id so a screenshot of the
// modal's *populated* state (facts + AI summary/action, not just the
// loading spinner) is possible without a real backend. Anything not listed
// here still gets a generic-but-fully-shaped response, so clicking any row
// on the Today page renders a real modal rather than a permanent spinner.
const ITEM_DETAILS = {
  c2: {
    id: "c2", kind: "event",
    facts: {
      title: "Design review", domain: "work", categoryLabel: "Meeting", status: "open",
      dueAt: "2026-08-25T18:00:00Z", when: "2:00 PM", duration: "1h",
      where: "Room 204", attendees: 3, source: "calendar", sourceLabel: "Calendar",
      from: null, url: null, priority: null, swatch: "work", color: "#c22a1f", importance: "medium",
    },
    ai: {
      summary: "A design review with your team to check progress before Friday's deadline. Three people are attending, including your manager, in Room 204.",
      action: "Bring your updated slides.",
    },
  },
  "dl-today-1": {
    id: "dl-today-1", kind: "deadline",
    facts: {
      title: "Library books due", domain: "personal", categoryLabel: "Admin", status: "open",
      dueAt: "2026-08-25T23:59:00Z", when: "11:59 PM", duration: null,
      where: null, attendees: null, source: "calendar", sourceLabel: "Calendar",
      from: null, url: null, priority: "medium", swatch: null, color: null, importance: "medium",
    },
    ai: {
      summary: "Two library books come due today. There's no fine amount noted, but returning them late usually adds a small daily charge.",
      action: "Drop the books off at the library before it closes.",
    },
  },
  "dl-today-2": {
    id: "dl-today-2", kind: "deadline",
    facts: {
      title: "Car inspection", domain: "personal", categoryLabel: "Admin", status: "open",
      dueAt: "2026-08-25T23:59:00Z", when: "11:59 PM", duration: null,
      where: null, attendees: null, source: "calendar", sourceLabel: "Calendar",
      from: null, url: null, priority: "high", swatch: null, color: null, importance: "high",
    },
    ai: null, // exercises the "AI summary isn't available right now" fallback path
  },
  dw1: {
    id: "dw1", kind: "allday",
    facts: {
      title: "Don't wanna", domain: "personal", categoryLabel: null, status: "open",
      dueAt: "2026-08-25", when: "All day", duration: null,
      where: null, attendees: null, source: "calendar", sourceLabel: "Calendar",
      from: null, url: null, priority: null, swatch: "personal", color: null, importance: "low",
    },
    ai: { summary: "A personal all-day marker with no further notes attached.", action: null },
  },
  // A Brightspace deadline whose course has a parsed syllabus on file — the
  // one demo fixture that exercises the item-modal-syllabus block (see
  // Display.jsx's ItemDetailModal and Display.css). Nothing else in this
  // harness renders that block, since every other fixture's facts.syllabus
  // is implicitly null (genericDetail() below sets it explicitly).
  bs1: {
    id: "bs1", kind: "deadline",
    facts: {
      title: "Assignment 2 — ELEC 2507", domain: "school", categoryLabel: "Deadline", status: "open",
      dueAt: "2026-08-29T23:59:00Z", when: "11:59 PM", duration: null,
      where: null, attendees: null, source: "brightspace", sourceLabel: "Brightspace",
      from: null, url: "https://brightspace.example.edu/d2l/le/calendar", priority: "medium", swatch: null, color: null, importance: "medium",
      syllabus: {
        courseCode: "ELEC 2507", courseName: "Digital Systems II",
        weightings: [
          { item: "Assignments", weight: 20, notes: null },
          { item: "Midterm", weight: 25, notes: null },
          { item: "Final Exam", weight: 40, notes: null },
        ],
        topics: [{ assessment: "Final Exam", chapters: "Ch. 1-9", scope: "Cumulative, emphasis on Ch. 6-9" }],
      },
    },
    ai: { summary: "The second assignment for ELEC 2507, worth part of your overall Assignments grade. No submission notes are attached beyond the due date.", action: "Check the Brightspace dropbox for the assignment brief before starting." },
  },
};
function genericDetail(id, kind) {
  return {
    id, kind: kind || "event",
    facts: {
      title: "Sample item", domain: "personal", categoryLabel: null, status: "open",
      dueAt: null, when: null, duration: null, where: null, attendees: null,
      source: "calendar", sourceLabel: "Calendar", from: null, url: null, priority: null,
      swatch: null, color: null, importance: "medium", syllabus: null,
    },
    ai: { summary: "No canned demo detail for this item id — this is a generic placeholder response.", action: null },
  };
}

// Canned answer for StockIdeaDetailModal (the "Worth a look" card's own
// on-demand panel, GET /api/stock-idea/:ticker/detail) — keyed by the demo
// stock idea's own ticker (see demo.json's portfolio.stockIdea), same
// "always fully shaped, never a permanent spinner" rule as ITEM_DETAILS
// above. Exercises the populated-AI path; STOCK_IDEA_DETAILS having no
// entry for a ticker falls through to genericStockIdeaDetail's AI-off path
// instead, same relationship as ITEM_DETAILS/genericDetail.
const STOCK_IDEA_DETAILS = {
  CELH: {
    ticker: "CELH", day: "2026-08-25", at: "2026-08-25T09:00:00Z",
    facts: {
      ticker: "CELH", name: "Celsius Holdings, Inc.", price: 32.14, currency: "USD",
      sector: "Consumer Defensive", industry: "Beverages - Non-Alcoholic",
      website: "https://www.celsiusholdingsinc.com", employees: 1250,
      marketCap: 7_800_000_000,
      businessSummary: "Celsius Holdings, Inc. develops, markets, distributes, and sells functional energy drinks and liquid supplements in the United States and internationally. The company offers CELSIUS, a fitness energy drink; and CELSIUS Powered by Fuel. It also provides its products online.",
      yahooUrl: "https://finance.yahoo.com/quote/CELH",
      trailingPE: 28.4, fiftyTwoWeekLow: 21.05, fiftyTwoWeekHigh: 49.8, dividendYieldPct: null,
      recommendationKey: "buy", recommendationLabel: "Buy", recommendationMean: 2.0, numberOfAnalystOpinions: 12,
      targetMeanPrice: 38.0, targetHighPrice: 48.0, targetLowPrice: 30.0, analystUpsidePct: 18.3,
      competitors: [
        { ticker: "MNST", name: "Monster Beverage Corporation", price: 51.2, currency: "USD" },
        { ticker: "KDP", name: "Keurig Dr Pepper Inc.", price: 33.6, currency: "USD" },
        { ticker: "PEP", name: "PepsiCo, Inc.", price: 168.4, currency: "USD" },
      ],
    },
    ai: {
      business: "Celsius makes and sells functional energy drinks and supplements, positioned as a fitness-oriented alternative to traditional energy drinks. Its CELSIUS and CELSIUS Powered by Fuel lines are sold across the US and internationally through retail and online channels.",
      competitive: "It competes directly with much larger beverage players like Monster and Keurig Dr Pepper, and indirectly with PepsiCo's broader drinks portfolio. Celsius is meaningfully smaller than all three by market cap, positioning it as a growth challenger in a market dominated by established brands.",
      analysts: "Analysts are moderately bullish: a Buy rating from 12 analysts, with a mean price target of $38 against a current price of about $32 — roughly 18% upside if that target holds.",
    },
  },
};
function genericStockIdeaDetail(ticker) {
  return {
    ticker, day: "2026-08-25", at: "2026-08-25T09:00:00Z",
    facts: {
      ticker, name: ticker, price: 10, currency: "USD", sector: null, industry: null,
      website: null, employees: null, marketCap: null,
      businessSummary: "No canned demo detail for this ticker — this is a generic placeholder response.",
      yahooUrl: `https://finance.yahoo.com/quote/${ticker}`,
      trailingPE: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null, dividendYieldPct: null,
      recommendationKey: null, recommendationLabel: null, recommendationMean: null, numberOfAnalystOpinions: null,
      targetMeanPrice: null, targetHighPrice: null, targetLowPrice: null, analystUpsidePct: null,
      competitors: [],
    },
    ai: null,
  };
}

// Canned answer for TickerDetailModal opened from an All Positions row
// (GET /api/positions/:ticker/detail, Round 48) — keyed by the demo
// portfolio's own short display tickers (see demo.json's
// portfolio.positions). Two shapes on purpose: MSFT exercises the fully-
// populated path (same shape STOCK_IDEA_DETAILS/CELH above exercises) so a
// screenshot shows the modal actually working for a holding, not just a
// stock idea; XEQT exercises the real degraded case Yahoo returns for an
// ETF (buildFacts' assetProfile-shaped fields — sector, employees, business
// summary — are genuinely null for a fund, since Yahoo profiles funds
// differently than equities) so that gap is visible and expected here
// rather than discovered for the first time against a live pull. Anything
// else (AMD, VFV) falls through to genericStockIdeaDetail's AI-off path,
// same relationship as ITEM_DETAILS/genericDetail.
const POSITION_DETAILS = {
  MSFT: {
    ticker: "MSFT", day: "2026-08-25", at: "2026-08-25T09:00:00Z",
    facts: {
      ticker: "MSFT", name: "Microsoft Corporation", price: 512.30, currency: "USD",
      sector: "Technology", industry: "Software - Infrastructure",
      website: "https://www.microsoft.com", employees: 228_000,
      marketCap: 3_810_000_000_000,
      businessSummary: "Microsoft Corporation develops, licenses, and supports software, services, devices, and solutions worldwide. Its Productivity and Business Processes segment offers Office, Exchange, SharePoint, Teams, and LinkedIn; its Intelligent Cloud segment offers Azure and other cloud services; and its More Personal Computing segment offers Windows, devices, gaming (Xbox), and search advertising.",
      yahooUrl: "https://finance.yahoo.com/quote/MSFT",
      trailingPE: 36.2, fiftyTwoWeekLow: 385.60, fiftyTwoWeekHigh: 520.10, dividendYieldPct: 0.7,
      recommendationKey: "buy", recommendationLabel: "Buy", recommendationMean: 1.6, numberOfAnalystOpinions: 41,
      targetMeanPrice: 545.0, targetHighPrice: 610.0, targetLowPrice: 470.0, analystUpsidePct: 6.4,
      competitors: [
        { ticker: "GOOGL", name: "Alphabet Inc.", price: 198.4, currency: "USD" },
        { ticker: "AMZN", name: "Amazon.com, Inc.", price: 231.1, currency: "USD" },
        { ticker: "ORCL", name: "Oracle Corporation", price: 178.9, currency: "USD" },
      ],
    },
    ai: {
      business: "Microsoft sells productivity software (Office, Teams), cloud infrastructure and services through Azure, and personal computing products including Windows and Xbox. Its revenue spans subscriptions, cloud consumption, licensing, and hardware.",
      competitive: "It competes with Alphabet and Amazon in cloud infrastructure, and with Oracle in enterprise software. Microsoft is the largest of the group by market cap, with a diversified base across productivity, cloud, and consumer products that the others don't fully match.",
      analysts: "Analysts are bullish: a Buy rating from 41 analysts, with a mean price target of $545 against a current price of about $512 — roughly 6% upside if that target holds.",
    },
  },
  XEQT: {
    ticker: "XEQT.TO", day: "2026-08-25", at: "2026-08-25T09:00:00Z",
    facts: {
      // A fund, not a company — Yahoo's assetProfile module (business
      // summary, sector, industry, employees) genuinely comes back empty
      // for an ETF like this; only price/name/marketCap and the analyst-
      // coverage fields (also genuinely empty — funds aren't rated) come
      // from modules Yahoo actually populates for a fund.
      ticker: "XEQT.TO", name: "iShares Core Equity ETF Portfolio", price: 34.87, currency: "CAD",
      sector: null, industry: null, website: null, employees: null,
      marketCap: null,
      businessSummary: null,
      yahooUrl: "https://finance.yahoo.com/quote/XEQT.TO",
      trailingPE: null, fiftyTwoWeekLow: 29.41, fiftyTwoWeekHigh: 35.62, dividendYieldPct: 1.8,
      recommendationKey: null, recommendationLabel: null, recommendationMean: null, numberOfAnalystOpinions: null,
      targetMeanPrice: null, targetHighPrice: null, targetLowPrice: null, analystUpsidePct: null,
      competitors: [],
    },
    ai: null,
  },
};

// Canned state for the ESP32 Wall control page (Round 49 §6) — mutable so
// the POST routes below can actually change what the next status fetch
// returns, same "acts like the real backend" spirit as the rest of this
// mock rather than a frozen fixture.
const MATRIX_SCREENS = [
  { id: "portfolio", label: "Portfolio", description: "Total value and today's change", hasData: true },
  { id: "markets", label: "Markets", description: "TSX / NASDAQ / S&P plus today's top movers", hasData: true },
  { id: "holdings", label: "Holdings", description: "Top 5 positions by value", hasData: true },
  { id: "events", label: "Today", description: "Today's calendar events and busy score", hasData: true },
  { id: "news", label: "News", description: "Latest market headlines", hasData: true },
  { id: "weather", label: "Weather", description: "No weather source is wired up yet — reserved for later", hasData: false },
];
const matrixState = {
  enabledScreens: ["portfolio", "markets", "holdings", "events", "news"],
  pinnedScreen: null,
  notification: null,
  testEvent: { id: 3, label: "Button 2 Pressed" },
  lastPolledAt: new Date(Date.now() - 4000).toISOString(),
};

window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/api/display")) return new Response(JSON.stringify(demo), { headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/matrix/status")) {
    const notification = matrixState.notification && new Date(matrixState.notification.expiresAt) > new Date()
      ? { text: matrixState.notification.text, secondsRemaining: Math.ceil((new Date(matrixState.notification.expiresAt) - Date.now()) / 1000) }
      : null;
    return new Response(JSON.stringify({
      screens: MATRIX_SCREENS,
      enabledScreens: matrixState.enabledScreens,
      pinnedScreen: matrixState.pinnedScreen,
      notification,
      testEvent: matrixState.testEvent,
      lastPolledAt: matrixState.lastPolledAt,
      online: true,
    }), { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/matrix/screens")) {
    matrixState.enabledScreens = JSON.parse(opts.body).enabledScreens;
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/matrix/pin")) {
    matrixState.pinnedScreen = JSON.parse(opts.body).screen ?? null;
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/matrix/notify/clear")) {
    matrixState.notification = null;
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/matrix/notify")) {
    const { text, durationSeconds } = JSON.parse(opts.body);
    matrixState.notification = { text, expiresAt: new Date(Date.now() + durationSeconds * 1000).toISOString() };
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/matrix/test")) {
    matrixState.testEvent = { id: matrixState.testEvent.id + 1, label: JSON.parse(opts.body).label };
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  // Matches the real SOURCE_NAMES list (backend/brief/compose.js's
  // COLLECTORS keys) as of round 47 — email/calendar/money/brightspace/
  // marketNews, not the stale email/calendar/money/vault this mock used
  // to carry (vault was never a real source name; it's the fallback path
  // sectorProfile.js reads, not a collector of its own).
  if (u.includes("/api/sources")) return new Response(JSON.stringify({ everyMinutes: 15, sources: [
    { name: "email", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
    { name: "calendar", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
    { name: "money", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
    { name: "brightspace", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
    { name: "marketNews", lastRun: null, lastError: { message: "ENOENT: feed list not found" } },
  ] }), { headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/system-health")) {
    const sources = [
      { name: "email", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
      { name: "calendar", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
      { name: "money", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
      { name: "brightspace", lastRun: new Date(Date.now() - 9 * 60000).toISOString(), lastError: null },
      { name: "marketNews", lastRun: null, lastError: { at: new Date().toISOString(), message: "ENOENT: feed list not found" } },
    ];
    return new Response(JSON.stringify({
      generatedAt: new Date().toISOString(),
      cpuTempC: 52.3,
      memory: { totalBytes: 1073741824, freeBytes: 611524608, usedPct: 43 },
      disk: { mountPoint: "/", totalBytes: 31138512896, freeBytes: 21855432704, usedPct: 30 },
      loadavg: [0.18, 0.22, 0.19],
      systemBootAt: new Date(Date.now() - 6 * 86400000).toISOString(),
      processStartedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
      syncthing: { unit: "syncthing@jonbourgy.service", active: true, status: "active" },
      watchdog: { unit: "syncthing-watchdog.timer", active: true, status: "active" },
      mainService: { unit: "pi-secretary.service", active: true, status: "active" },
      sources,
      everyMinutes: 15,
      problems: [
        { level: "warning", area: "source", message: "marketNews last errored: ENOENT: feed list not found" },
      ],
    }), { headers: { "Content-Type": "application/json" } });
  }
  const detailMatch = u.match(/\/api\/items\/([^/?]+)\/detail/);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    const kind = new URL(u, "http://x").searchParams.get("kind");
    const body = ITEM_DETAILS[id] || genericDetail(id, kind);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }
  const stockIdeaMatch = u.match(/\/api\/stock-idea\/([^/?]+)\/detail/);
  if (stockIdeaMatch) {
    const ticker = decodeURIComponent(stockIdeaMatch[1]);
    const body = STOCK_IDEA_DETAILS[ticker] || genericStockIdeaDetail(ticker);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }
  const positionMatch = u.match(/\/api\/positions\/([^/?]+)\/detail/);
  if (positionMatch) {
    const ticker = decodeURIComponent(positionMatch[1]);
    const body = POSITION_DETAILS[ticker] || genericStockIdeaDetail(ticker);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }
  // Round 55 follow-up — AskPanel's POST /api/ask. A short artificial delay
  // (real DeepSeek/Claude latency is in this ballpark) so a screenshot
  // mid-flight actually catches the typing-dots state rather than the
  // request always resolving before the next frame paints. Canned replies
  // keyed by a keyword in the question, same "always fully shaped" spirit
  // as the other mocks above, so any of the panel's own suggestion chips
  // produces a real, on-topic-looking answer rather than a placeholder.
  if (u.includes("/api/ask")) {
    const { message } = JSON.parse(opts.body);
    const q = message.toLowerCase();
    let answer = "You've got 2 events today and 4 open tasks — nothing urgent in the next hour.";
    if (q.includes("portfolio")) answer = "Your portfolio is up 0.8% today at $128,400 CAD, led by MSFT. Up 2.1% this week.";
    else if (q.includes("week")) answer = "This week: Assignment 2 for ELEC 2507 is due Saturday, and you have a design review Tuesday at 2pm.";
    else if (q.includes("today")) answer = "Today you have a design review at 2pm in Room 204, plus library books and a car inspection both due by end of day.";
    await new Promise((r) => setTimeout(r, 900));
    return new Response(JSON.stringify({ answer }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response("{}", { headers: { "Content-Type": "application/json" } });
};

function App() {
  useEffect(() => {
    const p = new URLSearchParams(location.search).get("page");
    if (p) setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: p })), 60);
  }, []);
  return <Display />;
}
createRoot(document.getElementById("root")).render(<App />);
