// pipeline.js
//
// Orchestrates multiple insight generators (investment, emails, goals, etc.)
// and combines them into a single briefing.
//
// Each insight generator is a separate module—easy to add new ones.
// This runs on a schedule; the frontend just reads the cached output.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getPortfolioSummary, getNewsSummary } from "./marketData.js";
import { generateInvestmentInsights } from "./investmentInsights.js";
import { generateEmailInsights } from "./emailInsights.js";
import { generateCalendarInsights } from "./calendarInsights.js";
// Future: import { generateGoalInsights } from "./goalInsights.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSIGHTS_PATH = path.join(__dirname, "..", "data", "insights.json");
const PORTFOLIO_CACHE_PATH = path.join(__dirname, "..", "data", "portfolio-cached.json");

async function loadConfig() {
  return JSON.parse(
    await fs.readFile(path.join(__dirname, "..", "config.json"), "utf-8")
  );
}

async function loadCurrentInsights() {
  try {
    const raw = await fs.readFile(INSIGHTS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { generatedAt: null, provider: null, insights: [] };
  }
}

async function saveInsights(insightsOutput) {
  await fs.writeFile(INSIGHTS_PATH, JSON.stringify(insightsOutput, null, 2));
}

export async function runPipeline() {
  const config = await loadConfig();

  console.log(`[pipeline] Running with provider "${config.aiProvider}"...`);

  try {
    // Fetch portfolio and market data
    const [portfolio, news] = await Promise.all([
      getPortfolioSummary(),
      getNewsSummary()
    ]);

    // Generate insights from multiple sources
    const investmentInsights = await generateInvestmentInsights(portfolio, config);

    let emailInsights = [];
    try {
      emailInsights = await generateEmailInsights(config);
    } catch (emailErr) {
      console.error("[pipeline] emailInsights error:", emailErr.message);
    }

    let calendarInsights = [];
    try {
      calendarInsights = await generateCalendarInsights(config);
    } catch (calendarErr) {
      console.error("[pipeline] calendarInsights error:", calendarErr.message);
    }

    // Future: Compose additional insight generators here
    // const goalInsights = await generateGoalInsights(portfolio, config);

    // Combine all insights
    const allInsights = [
      ...investmentInsights,
      ...emailInsights,
      ...calendarInsights,
      // ...goalInsights,
    ];

    // Save insights
    const insightsOutput = {
      generatedAt: new Date().toISOString(),
      provider: config.aiProvider,
      insights: allInsights
    };
    await saveInsights(insightsOutput);

    // Cache portfolio data for fast API responses
    const portfolioOutput = { portfolio, news };
    await fs.writeFile(PORTFOLIO_CACHE_PATH, JSON.stringify(portfolioOutput, null, 2));

    console.log(`[pipeline] ✓ Generated ${allInsights.length} total insights (investment: ${investmentInsights.length}, email: ${emailInsights.length}, calendar: ${calendarInsights.length})`);

    return { ok: true, insightCount: allInsights.length };
  } catch (err) {
    console.error("[pipeline] Error:", err.message);
    throw err;
  }
}

// --- Modular refresh functions ---

export async function refreshEmailInsights() {
  const config = await loadConfig();
  console.log("[pipeline] Refreshing email insights only...");

  try {
    const current = await loadCurrentInsights();
    const emailInsights = await generateEmailInsights(config);

    // Replace only email insights, keep others
    const otherInsights = current.insights.filter(i => i.category !== "email");
    const allInsights = [...otherInsights, ...emailInsights];

    const insightsOutput = {
      generatedAt: new Date().toISOString(),
      provider: config.aiProvider,
      insights: allInsights
    };
    await saveInsights(insightsOutput);

    console.log(`[pipeline] ✓ Refreshed email insights (${emailInsights.length} insights)`);
    return { ok: true, type: "email", insightCount: emailInsights.length };
  } catch (err) {
    console.error("[pipeline] Email refresh error:", err.message);
    throw err;
  }
}

export async function refreshCalendarInsights() {
  const config = await loadConfig();
  console.log("[pipeline] Refreshing calendar insights only...");

  try {
    const current = await loadCurrentInsights();
    const calendarInsights = await generateCalendarInsights(config);

    // Replace only calendar insights, keep others
    const otherInsights = current.insights.filter(i => i.category !== "calendar");
    const allInsights = [...otherInsights, ...calendarInsights];

    const insightsOutput = {
      generatedAt: new Date().toISOString(),
      provider: config.aiProvider,
      insights: allInsights
    };
    await saveInsights(insightsOutput);

    console.log(`[pipeline] ✓ Refreshed calendar insights (${calendarInsights.length} insights)`);
    return { ok: true, type: "calendar", insightCount: calendarInsights.length };
  } catch (err) {
    console.error("[pipeline] Calendar refresh error:", err.message);
    throw err;
  }
}

export async function refreshInvestmentInsights() {
  const config = await loadConfig();
  console.log("[pipeline] Refreshing investment insights only...");

  try {
    const [portfolio] = await Promise.all([
      getPortfolioSummary()
    ]);

    const current = await loadCurrentInsights();
    const investmentInsights = await generateInvestmentInsights(portfolio, config);

    // Replace only investment insights, keep others
    const otherInsights = current.insights.filter(i => i.category !== "investment");
    const allInsights = [...otherInsights, ...investmentInsights];

    const insightsOutput = {
      generatedAt: new Date().toISOString(),
      provider: config.aiProvider,
      insights: allInsights
    };
    await saveInsights(insightsOutput);

    console.log(`[pipeline] ✓ Refreshed investment insights (${investmentInsights.length} insights)`);
    return { ok: true, type: "investment", insightCount: investmentInsights.length };
  } catch (err) {
    console.error("[pipeline] Investment refresh error:", err.message);
    throw err;
  }
}
