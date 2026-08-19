// investmentInsights.js
//
// Generates focused investment insights (1-2 max).
// One insight generator among many—other modules (emailInsights, goalInsights, etc.)
// will be added later and composed together in the pipeline.

import { generateInsights } from "./aiClient.js";
import { getMarketContext, formatContextForPrompt } from "./marketContext.js";

/**
 * Build a concise investment-focused prompt.
 * Portfolio + market reality → 1-2 actionable insights max.
 */
function buildInvestmentPrompt(portfolio, marketContext) {
  let prompt = "";

  // Portfolio snapshot: sector allocation + biggest positions
  prompt += "## Your Portfolio Snapshot\n";
  const sectorAllocation = {};
  portfolio.holdings.forEach(h => {
    if (!sectorAllocation[h.sector]) sectorAllocation[h.sector] = 0;
    sectorAllocation[h.sector] += h.value || 0;
  });
  const totalValue = Object.values(sectorAllocation).reduce((a, b) => a + b, 0);

  prompt += "Sector allocation: ";
  const topSectors = Object.entries(sectorAllocation)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([sector, value]) => {
      const pct = totalValue > 0 ? ((value / totalValue) * 100).toFixed(0) : 0;
      return `${sector} ${pct}%`;
    })
    .join(", ");
  prompt += topSectors + "\n\n";

  // Top 3 positions
  prompt += "Top positions: ";
  const top3 = portfolio.holdings
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 3)
    .map(h => `${h.ticker} ($${(h.value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })})`)
    .join(", ");
  prompt += top3 + "\n\n";

  // Market context (lean version)
  prompt += formatContextForPrompt(marketContext);

  // The directive
  prompt += "\n## Your Task\n";
  prompt += "Generate 1-2 investment insights ONLY. Each must be a concise, actionable observation connecting portfolio exposure to current market reality. No generic statements. Focus on what actually matters for 1-3 year decisions. Skip everything else.\n";

  return prompt;
}

/**
 * Generate investment insights.
 * Returns array of insight objects: { text, priority, category: "investment" }
 */
export async function generateInvestmentInsights(portfolio, config) {
  try {
    // Fetch lean market context
    const marketContext = await getMarketContext();

    // Build focused prompt
    const userPrompt = buildInvestmentPrompt(portfolio, marketContext);

    // Use investment system prompt from config
    const investmentConfig = {
      ...config,
      systemPrompt: (config.investmentSystemPrompt || config.systemPrompt) + "\n\nGenerate ONLY 1-2 insights max. Ignore index funds—focus only on the volatile, interesting holdings."
    };

    // Generate insights
    const rawInsights = await generateInsights(userPrompt, investmentConfig);

    // Ensure they're marked as investment insights and limited to 1-2
    return rawInsights
      .slice(0, 2)
      .map(insight => ({
        ...insight,
        category: "investment"
      }));
  } catch (err) {
    console.error("[investmentInsights] Error:", err.message);
    return [];
  }
}
