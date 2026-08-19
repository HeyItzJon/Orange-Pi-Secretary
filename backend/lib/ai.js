// ai.js
//
// The only file that talks to a model, and it is used for exactly two jobs:
//   1. classifying the handful of emails that survived the deterministic
//      filters (one batched call, never one call per email)
//   2. writing one short summary line for the brief
//
// Everything else — what's urgent, what repeats, what gets shown — is decided
// by rules in brief/rules.js. That is deliberate. The model reads and writes;
// it does not decide what matters.
//
// Every call is cached by content hash, so re-running the pipeline on
// unchanged input costs nothing.

import axios from "axios";
import { logger } from "./log.js";
import { cacheGet, cacheSet, addUsage } from "./store.js";

const log = logger("ai");
const TIMEOUT = 45000;

class AIUnavailable extends Error {}

async function callDeepSeek({ system, user, model, maxTokens, json }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new AIUnavailable("DEEPSEEK_API_KEY missing");

  const res = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: model || "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: TIMEOUT,
    }
  );

  return {
    text: res.data.choices?.[0]?.message?.content || "",
    usage: {
      promptTokens: res.data.usage?.prompt_tokens || 0,
      completionTokens: res.data.usage?.completion_tokens || 0,
    },
  };
}

async function callClaude({ system, user, model, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIUnavailable("ANTHROPIC_API_KEY missing");

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: model || "claude-sonnet-5",
      max_tokens: maxTokens,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: TIMEOUT,
    }
  );

  return {
    text: res.data.content?.find((b) => b.type === "text")?.text || "",
    usage: {
      promptTokens: res.data.usage?.input_tokens || 0,
      completionTokens: res.data.usage?.output_tokens || 0,
    },
  };
}

function extractJson(raw) {
  let s = String(raw).trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // Last resort: grab the outermost {...} or [...] and try again.
    const m = s.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch { /* fall through */ }
    }
    log.warn("could not parse model output as JSON");
    return null;
  }
}

/**
 * One call, cached, with a single retry on transient failure.
 * Returns null rather than throwing when the model is unreachable — the
 * brief must still render without it.
 */
export async function ask({ system, user, config, maxTokens = 700, json = true, cacheAs = null }) {
  if (cacheAs) {
    const hit = await cacheGet(cacheAs);
    if (hit !== null) {
      log.debug(`cache hit ${cacheAs}`);
      return hit;
    }
  }

  const provider = config?.ai?.provider || "deepseek";
  const model = config?.ai?.model?.[provider];

  if (provider === "off") return null;

  const run = provider === "claude" ? callClaude : callDeepSeek;

  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, usage } = await run({ system, user, model, maxTokens, json });
      await addUsage({ calls: 1, ...usage });
      const value = json ? extractJson(text) : text.trim();
      if (value === null) return null;
      if (cacheAs) await cacheSet(cacheAs, value);
      log.info(`${provider} ok (${usage.promptTokens}+${usage.completionTokens} tok)`);
      return value;
    } catch (err) {
      last = err;
      if (err instanceof AIUnavailable) {
        log.warn(err.message);
        return null;
      }
      const status = err.response?.status;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt === 1) break;
      log.warn(`attempt ${attempt + 1} failed (${status || err.code}), retrying`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  log.error(`AI call failed: ${last?.response?.data?.error?.message || last?.message}`);
  return null;
}
