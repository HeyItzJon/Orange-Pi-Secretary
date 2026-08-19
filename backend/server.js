import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { startScheduler } from "./modules/scheduler.js";
import { runPipeline, refreshEmailInsights, refreshCalendarInsights, refreshInvestmentInsights } from "./modules/pipeline.js";
import { getPortfolioSummary, getNewsSummary } from "./modules/marketData.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSIGHTS_PATH = path.join(__dirname, "data", "insights.json");
const PORTFOLIO_CACHE_PATH = path.join(__dirname, "data", "portfolio-cached.json");
const OPPORTUNITY_PATH = path.join(__dirname, "data", "opportunity.json");
const FRONTEND_DIST = path.join(__dirname, "..", "frontend", "dist");

const app = express();
app.use(cors());
app.use(express.json());

// --- API routes ---

app.get("/api/insights", async (req, res) => {
  try {
    const raw = await fs.readFile(INSIGHTS_PATH, "utf-8");
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(200).json({ generatedAt: null, provider: null, insights: [] });
  }
});

// Full pipeline refresh
app.post("/api/refresh", async (req, res) => {
  try {
    const result = await runPipeline();
    res.json(result || { ok: false, message: "Pipeline ran but produced no output - check server logs." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Modular refreshes
app.post("/api/refresh-emails", async (req, res) => {
  try {
    const result = await refreshEmailInsights();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh-calendar", async (req, res) => {
  try {
    const result = await refreshCalendarInsights();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh-investments", async (req, res) => {
  try {
    const result = await refreshInvestmentInsights();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve cached portfolio data (updated every 2 hours by scheduler, not on-demand)
app.get("/api/portfolio", async (req, res) => {
  try {
    const raw = await fs.readFile(PORTFOLIO_CACHE_PATH, "utf-8");
    res.json(JSON.parse(raw));
  } catch (err) {
    // Fallback: generate fresh data if cache doesn't exist (e.g., first run)
    console.log("[api] No cached portfolio found, fetching fresh data...");
    try {
      const [portfolio, news] = await Promise.all([getPortfolioSummary(), getNewsSummary()]);
      res.json({ portfolio, news });
    } catch (fetchErr) {
      res.status(500).json({ error: "Failed to fetch portfolio data" });
    }
  }
});

// Serve daily investment opportunity
app.get("/api/opportunity", async (req, res) => {
  try {
    const raw = await fs.readFile(OPPORTUNITY_PATH, "utf-8");
    res.json(JSON.parse(raw));
  } catch (err) {
    // No opportunity generated yet
    res.status(200).json({ error: "No opportunity generated yet" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Serve the built frontend (after you run `npm run build` in /frontend) ---
app.use(express.static(FRONTEND_DIST));
app.get("*", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
    if (err) res.status(404).send("Frontend not built yet. Run 'npm run build' inside /frontend, or use 'npm run dev' in /frontend for local testing.");
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] Running at http://localhost:${PORT}`);
  startScheduler();
});
