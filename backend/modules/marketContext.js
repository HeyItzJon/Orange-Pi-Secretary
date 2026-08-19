// marketContext.js
//
// Lean market context for investment analysis.
// Fed rate, sector movers, key risks. No comprehensive market briefing—just what matters.

/**
 * Current Fed rate and outlook (placeholder).
 */
async function getFedContext() {
  try {
    return {
      rate: "5.25-5.50%",
      outlook: "Holding; possible cut in Q1 2027 if inflation cools"
    };
  } catch (err) {
    return { rate: "unknown", outlook: "unavailable" };
  }
}

/**
 * Top sector movers YTD (placeholder).
 */
async function getSectorMovers() {
  try {
    return {
      top: [
        { sector: "Industrials", ytd: "+6.1%", note: "Defense spending strong" },
        { sector: "Technology", ytd: "+8.2%", note: "AI demand sustains" },
        { sector: "Energy", ytd: "-3.1%", note: "Oil pressure; tariff risk" }
      ]
    };
  } catch (err) {
    return { top: [] };
  }
}

/**
 * Key geopolitical/macro risks (placeholder).
 */
async function getKeyRisks() {
  try {
    return [
      "US-China tariff escalation (affects tech supply chains)",
      "USD strength (CAD/USD parity; export pressure)",
      "Oil stability ~$75/bbl; no major swings expected"
    ];
  } catch (err) {
    return [];
  }
}

/**
 * Main entry point: gather lean market context.
 */
export async function getMarketContext() {
  const [fed, sectors, risks] = await Promise.all([
    getFedContext(),
    getSectorMovers(),
    getKeyRisks()
  ]);

  return { fed, sectors, risks };
}

/**
 * Format for investment prompt.
 */
export function formatContextForPrompt(context) {
  let text = "## Market Reality\n\n";

  if (context.fed) {
    text += `**Fed**: ${context.fed.rate}. ${context.fed.outlook}\n\n`;
  }

  if (context.sectors?.top?.length) {
    text += "**Sector Movers (YTD)**:\n";
    context.sectors.top.forEach(s => {
      text += `- ${s.sector}: ${s.ytd} (${s.note})\n`;
    });
    text += "\n";
  }

  if (context.risks?.length) {
    text += "**Key Risks**:\n";
    context.risks.forEach(r => {
      text += `- ${r}\n`;
    });
  }

  return text;
}
