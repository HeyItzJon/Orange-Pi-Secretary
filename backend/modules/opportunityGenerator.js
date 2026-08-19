// opportunityGenerator.js
//
// Generates one daily investment opportunity pitch.
// Uses portfolio context + market trends to identify aligned opportunities.
// Caches by date so it regenerates once per day.

import { generateJSON } from "./aiClient.js";
import { getMarketContext, formatContextForPrompt } from "./marketContext.js";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "opportunity-cache.json");

/**
 * Get today's date as YYYY-MM-DD for cache invalidation
 */
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Load cached opportunity if it's from today
 */
function loadCachedOpportunity() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (data.cachedDate === getTodayString()) {
      return data.opportunity;
    }
  } catch (err) {
    console.warn("[opportunityGenerator] Cache read error:", err.message);
  }
  return null;
}

/**
 * Save opportunity to daily cache
 */
function saveCachedOpportunity(opportunity) {
  try {
    const data = {
      cachedDate: getTodayString(),
      opportunity
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn("[opportunityGenerator] Cache write error:", err.message);
  }
}

/**
 * Build prompt for opportunity research.
 * Portfolio + market context → One emerging investment aligned with thesis.
 */
function buildOpportunityPrompt(portfolio, marketContext) {
  let prompt = "";

  // Portfolio context for alignment
  prompt += "## Your Investment Thesis\n";
  const sectorAllocation = {};
  portfolio.holdings.forEach(h => {
    if (!sectorAllocation[h.sector]) sectorAllocation[h.sector] = 0;
    sectorAllocation[h.sector] += h.value || 0;
  });
  const topSectors = Object.entries(sectorAllocation)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([sector]) => sector)
    .join(", ");

  prompt += `Key focus areas: ${topSectors}\n`;
  prompt += `Timeframe: 1-3 year hold.\n`;
  prompt += `Philosophy: Emerging opportunities, forward-looking, innovation-driven, geopolitical shifts.\n\n`;

  // Market context
  prompt += formatContextForPrompt(marketContext);

  // The directive
  prompt += "\n## Your Task\n";
  prompt += `Find ONE publicly traded stock or company that:
1. Aligns with innovation/geopolitical shifts/next-wave themes
2. Could be underground buzz or emerging but with real thesis
3. Is a good 1-3 year opportunity
4. Fits the investor's overall philosophy (tech, defense, energy, materials, etc.)

Respond with ONLY this JSON structure (no markdown, no extra text):
{
  "ticker": "TICKER",
  "company": "Company Name",
  "pitch": "1-2 paragraph pitch: what it is, why now, basic thesis.",
  "evidence": "Key factors: recent developments, market position, tailwinds, catalysts.",
  "thesis": "Why it aligns with your investment style: innovation/geo/trend angle."
}`;

  return prompt;
}

/**
 * Generate a single daily investment opportunity.
 * Returns { ticker, company, pitch, evidence, thesis, generatedAt }
 * or null if generation fails.
 */
export async function generateOpportunity(portfolio, config) {
  try {
    // Check cache first
    const cached = loadCachedOpportunity();
    if (cached) {
      console.log("[opportunityGenerator] Returning cached opportunity for", getTodayString());
      return cached;
    }

    console.log("[opportunityGenerator] Generating fresh opportunity for", getTodayString());

    // Fetch market context
    const marketContext = await getMarketContext();

    // Build prompt
    const userPrompt = buildOpportunityPrompt(portfolio, marketContext);

    // Override system prompt for opportunity research
    const opportunityConfig = {
      ...config,
      systemPrompt: "You are a plain-English investment researcher. Find ONE publicly traded company that fits this investor's thesis (innovation, geopolitical shifts, next-wave trends). In the JSON: use simple language in pitch/evidence/thesis. Avoid jargon—explain why it matters, not the mechanics. Return ONLY valid JSON, no markdown or extra text."
    };

    // Generate JSON object directly
    const opportunity = await generateJSON(opportunityConfig.systemPrompt, userPrompt, opportunityConfig);

    if (!opportunity || !opportunity.ticker) {
      console.error("[opportunityGenerator] Invalid opportunity structure:", opportunity);
      return null;
    }

    // Add metadata
    opportunity.generatedAt = new Date().toISOString();

    // Cache it
    saveCachedOpportunity(opportunity);

    return opportunity;
  } catch (err) {
    console.error("[opportunityGenerator] Error:", err.message);
    return null;
  }
}
