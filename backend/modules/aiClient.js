// aiClient.js
//
// This is the ONLY file that knows how to talk to a specific AI provider.
// Every provider function takes the same input (systemPrompt, userPrompt, config)
// and returns the same output (an array of insight objects).
//
// To add a new provider (e.g. Hermes running locally on the Pi), copy the
// shape of one of the functions below, then add it to the `providers` map
// at the bottom.

import axios from "axios";

// ---------- Shared: the "shape" every provider must return ----------
// [
//   { category: "sector", text: "...", priority: "high" | "medium" | "low" }
// ]

// ---------- Mock provider (no API key, no cost, for testing the pipeline) ----------
async function runMock(systemPrompt, userPrompt, config) {
  const samples = {
    sector: "Energy holdings facing headwinds from lower oil, but tariff uncertainty could reverse this.",
    trends: "Uranium volatility high; geopolitical support from Western allies offsetting supply fears.",
    macro: "USD strength benefits US holdings; watch CAD/USD parity for export-heavy positions.",
    geopolitical: "Tariff talk could impact semiconductor costs; monitor US-China escalation."
  };
  const priorities = ["high", "medium", "low"];

  return [
    { category: "sector", text: samples.sector, priority: "high" },
    { category: "trends", text: samples.trends, priority: "medium" },
    { category: "macro", text: samples.macro, priority: "medium" },
    { category: "geopolitical", text: samples.geopolitical, priority: "low" }
  ];
}

// ---------- DeepSeek provider ----------
async function runDeepSeek(systemPrompt, userPrompt, config) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing from .env");

  const response = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: config.model.deepseek || "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt + "\n\nRespond ONLY with a JSON array, no other text. Each item: {\"category\": string, \"text\": string, \"priority\": \"high\"|\"medium\"|\"low\"}. Categories: sector, trends, macro, geopolitical." },
        { role: "user", content: userPrompt }
      ]
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  const raw = response.data.choices[0].message.content;
  return parseJsonArraySafely(raw);
}

// ---------- Claude provider ----------
async function runClaude(systemPrompt, userPrompt, config) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing from .env");

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: config.model.claude || "claude-sonnet-5",
      max_tokens: 1000,
      system: systemPrompt + "\n\nRespond ONLY with a JSON array, no other text. Each item: {\"category\": string, \"text\": string, \"priority\": \"high\"|\"medium\"|\"low\"}. Categories: sector, trends, macro, geopolitical.",
      messages: [{ role: "user", content: userPrompt }]
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      }
    }
  );

  const raw = response.data.content.find(b => b.type === "text")?.text || "[]";
  return parseJsonArraySafely(raw);
}

function parseJsonArraySafely(raw) {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    // Remove opening fence (with or without "json" specifier)
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "");
    // Remove closing fence
    cleaned = cleaned.replace(/\n?```$/, "");
  }
  cleaned = cleaned.trim();

  // Try to fix common JSON issues: missing commas before quoted fields
  cleaned = cleaned.replace(/"\s*\n\s*"/g, '",\n"');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Failed to parse AI response as JSON:", cleaned);
    return [];
  }
}

// ---------- Provider registry ----------
const providers = {
  mock: runMock,
  deepseek: runDeepSeek,
  claude: runClaude
};

/**
 * Generate insights using whichever provider is set in config.json.
 */
export async function generateInsights(userPrompt, config) {
  const provider = providers[config.aiProvider];
  if (!provider) {
    throw new Error(`Unknown aiProvider "${config.aiProvider}" in config.json. Options: ${Object.keys(providers).join(", ")}`);
  }
  return provider(config.systemPrompt, userPrompt, config);
}

/**
 * Generate arbitrary JSON from AI provider.
 * Used for opportunities, custom research, etc.
 */
export async function generateJSON(systemPrompt, userPrompt, config) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing from .env");

  const response = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: config.model.deepseek || "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  const raw = response.data.choices[0].message.content;
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    // Remove opening fence (with or without "json" specifier)
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "");
    // Remove closing fence
    cleaned = cleaned.replace(/\n?```$/, "");
  }
  cleaned = cleaned.trim();

  // Try to fix common JSON issues: missing commas before quoted fields
  cleaned = cleaned.replace(/"\s*\n\s*"/g, '",\n"');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("[aiClient] Failed to parse JSON response:", cleaned);
    return null;
  }
}
