// sources/email.js
//
// Turns the inbox into items, spending as little as possible to do it.
//
// The order of operations here IS the cost control:
//
//   1. list message ids           — 1 API call
//   2. drop ids we've seen before — 0 calls, 0 tokens. On a normal run this
//                                   removes most of them, because Gmail
//                                   message ids are immutable.
//   3. fetch metadata for the rest — headers only, bounded concurrency
//   4. deterministic triage        — newsletters out, your VIP rules in,
//                                    everything unscored dropped. 0 tokens.
//   5. ONE batched AI call on whatever survived, usually 0–5 emails.
//
// A quiet morning costs one Gmail list call and nothing else.

import { logger } from "../lib/log.js";
import { listMessageIds, getMessagesMetadata } from "../lib/google.js";
import { knownMessageIds, rememberMessageIds } from "../lib/store.js";
import { ask } from "../lib/ai.js";
import { itemId, contentHash, cacheKey } from "../lib/ids.js";

const log = logger("email");

/** Word-boundary match so "mom" doesn't fire on "moment". */
function hasToken(haystack, token) {
  const t = token.toLowerCase().trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function senderAddress(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : from || "").toLowerCase().trim();
}

function senderName(from) {
  return String(from).replace(/<[^>]*>/, "").replace(/"/g, "").trim();
}

/**
 * Score an email against the user's rules. Pure function, no API, no tokens.
 * Returns { score, tier, reasons } — score 0 means "not worth a token".
 */
export function triage(msg, rules) {
  const from = String(msg.from || "").toLowerCase();
  const addr = senderAddress(msg.from);
  const subject = String(msg.subject || "");
  const haystack = `${from} ${subject} ${msg.snippet || ""}`.toLowerCase();

  const reasons = [];
  let score = 0;
  let tier = null;

  // Hard mute — automated senders that never need a human.
  for (const m of rules.mute || []) {
    if (addr.includes(m.toLowerCase())) return { score: 0, tier: null, reasons: ["muted sender"] };
  }

  // Named people. Highest-confidence signal we have.
  for (const person of rules.people || []) {
    const hit = (person.match || []).some(
      (token) => hasToken(from, token) || addr.includes(token.toLowerCase())
    );
    if (hit) {
      const s = rules.tierScores?.[person.tier] ?? 80;
      if (s > score) { score = s; tier = person.tier; }
      reasons.push(`from ${person.label}`);
      break;
    }
  }

  // Known domains (work).
  for (const d of rules.domains || []) {
    if (addr.endsWith(`@${d.match.toLowerCase()}`) || addr.endsWith(`.${d.match.toLowerCase()}`)) {
      const s = rules.tierScores?.[d.tier] ?? 80;
      if (s > score) { score = s; tier = d.tier; }
      reasons.push(d.label);
      break;
    }
  }

  // Topic keywords.
  for (const [topic, spec] of Object.entries(rules.topics || {})) {
    const hit = (spec.keywords || []).find((k) => hasToken(haystack, k));
    if (hit) {
      const s = spec.score ?? 60;
      if (s > score) { score = s; tier = topic; }
      reasons.push(`${topic}: "${hit}"`);
    }
  }

  // Newsletters are dropped unless a person/domain rule already claimed them.
  if (msg.isNewsletter && !["family", "work", "opportunity"].includes(tier)) {
    return { score: 0, tier: null, reasons: ["newsletter"] };
  }

  // Gmail's own IMPORTANT marker is a weak tiebreaker, never a promotion.
  if (score > 0 && msg.labelIds?.includes("IMPORTANT")) score += 2;

  return { score, tier, reasons };
}

const CLASSIFY_SYSTEM = `You are an email triage assistant. For each numbered email you receive, decide what a busy university student who also works part-time needs to know.

Return json with this exact shape:
{"results":[{"n":1,"needsReply":true,"dueAt":"2026-09-02","oneLine":"..."}]}

Rules:
- "needsReply": true only if a human specifically needs THIS person to respond or act. Notifications, receipts, confirmations and FYI mail are false.
- "dueAt": an ISO date (YYYY-MM-DD) ONLY if the email states or clearly implies a deadline. Otherwise null. Never invent one.
- "oneLine": under 90 characters, concrete, no preamble. Say what it is and what it wants. Never start with "This email".
- Return exactly one result per email, in order, using the given "n".`;

function buildClassifyPrompt(candidates, todayISO) {
  const lines = candidates.map((c, i) => {
    const parts = [
      `${i + 1}. From: ${senderName(c.msg.from) || senderAddress(c.msg.from)}`,
      `   Subject: ${c.msg.subject}`,
      `   Preview: ${(c.msg.snippet || "").slice(0, 220)}`,
    ];
    return parts.join("\n");
  });
  return `Today is ${todayISO}. Return json for these ${candidates.length} email(s).\n\n${lines.join("\n\n")}`;
}

export async function collectEmail(config, { force = false } = {}) {
  const rules = config.rules || {};
  const cfg = config.email || {};

  const ids = await listMessageIds({
    query: cfg.query || "in:inbox newer_than:14d",
    maxResults: cfg.maxResults || 40,
  });
  if (!ids.length) {
    log.info("inbox query returned nothing");
    return [];
  }

  const seen = await knownMessageIds();
  const fresh = force ? ids : ids.filter((id) => !seen.has(id));

  log.info(`${ids.length} messages matched, ${fresh.length} new`);
  if (!fresh.length) return []; // the cheap path: zero further spend

  const messages = await getMessagesMetadata(fresh, { concurrency: 5 });
  await rememberMessageIds(fresh);

  // ---- deterministic triage: free, and it removes most of the volume ----
  const minScore = cfg.minScore ?? 60;
  const candidates = [];
  for (const msg of messages) {
    const t = triage(msg, rules);
    if (t.score >= minScore) candidates.push({ msg, ...t });
  }

  log.info(`${candidates.length}/${messages.length} passed triage (min score ${minScore})`);
  if (!candidates.length) return [];

  // ---- one AI call for everything that survived ----
  const todayISO = new Date().toISOString().slice(0, 10);
  const key = cacheKey(
    "email-classify",
    candidates.map((c) => `${c.msg.id}:${c.msg.subject}`).sort()
  );

  const parsed = await ask({
    system: CLASSIFY_SYSTEM,
    user: buildClassifyPrompt(candidates, todayISO),
    config,
    maxTokens: 90 * candidates.length + 200,
    json: true,
    cacheAs: key,
  });

  const byN = new Map();
  for (const r of parsed?.results || []) {
    if (typeof r?.n === "number") byN.set(r.n, r);
  }

  // ---- build items; degrade gracefully if the model was unavailable ----
  return candidates.map((c, i) => {
    const ai = byN.get(i + 1) || {};
    const title = (ai.oneLine || c.msg.subject || "").toString().slice(0, 160);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(ai.dueAt || "") ? `${ai.dueAt}T23:59:00` : null;
    const needsReply = ai.needsReply === true;

    return {
      id: itemId("email", c.msg.threadId),
      source: "email",
      kind: needsReply ? "needs-reply" : "fyi",
      title,
      detail: `${senderName(c.msg.from) || senderAddress(c.msg.from)} — ${c.msg.subject}`,
      url: `https://mail.google.com/mail/u/0/#inbox/${c.msg.threadId}`,
      dueAt: due,
      priority: c.score + (needsReply ? 5 : 0),
      tier: c.tier || "personal",
      reasons: c.reasons,
      contentHash: contentHash({ s: c.msg.subject, n: title, d: due, r: needsReply }),
      meta: { from: senderName(c.msg.from), address: senderAddress(c.msg.from), needsReply },
    };
  });
}
