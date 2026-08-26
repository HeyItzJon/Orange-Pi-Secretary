// sources/email.js
//
// Turns the inbox into items, spending as little as possible to do it.
//
// The order of operations IS the cost control:
//
//   1. list message ids                — 1 API call
//   2. list ids matching "boost" queries — 1 call per tier. Gmail runs these
//      full-text server-side, so mail that mentions your workplace in the
//      BODY, or is signed by a colleague at the bottom, is found without ever
//      downloading a message. This also rescues important mail that fell past
//      the main list's cap.
//   3. drop ids already seen           — 0 calls, 0 tokens. Gmail message ids
//      are immutable, so on a normal run this removes most of them.
//   4. fetch metadata for the rest     — headers only, bounded concurrency
//   5. deterministic triage            — newsletters out, your rules in,
//      anything unscored dropped. Still 0 tokens.
//   6. fetch FULL BODY for whatever survived triage — usually 0–5 emails.
//      This is the one deliberately-not-cheap step: a deadline stated past
//      the first ~220 characters of the preview (the snippet's own length)
//      was getting missed entirely, so the AI classifier below reads the
//      real body text now, not just Gmail's own preview of it.
//   7. ONE batched AI call on those same 0–5 emails, using that body text.
//
// A quiet morning still costs three list calls and nothing else — steps 6
// and 7 only ever run over whatever's left after triage, never the whole
// fetched batch.

import { logger } from "../lib/log.js";
import { listMessageIds, getMessagesMetadata, getMessagesBody } from "../lib/google.js";
import { knownMessageIds, rememberMessageIds } from "../lib/store.js";
import { ask } from "../lib/ai.js";
import { itemId, contentHash, cacheKey } from "../lib/ids.js";
import { categorise, deriveDomain, isEmphasised } from "../lib/classify.js";

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
 * Only distinctive terms are worth a full-text search. Searching bodies for
 * "mom" or "job" returns half the inbox; searching for "Priya Raman" or
 * "richcraft" returns exactly what you want. The bar: a multi-word phrase, or
 * a single word long enough to be specific.
 */
export function isDistinctive(term) {
  const t = String(term || "").trim();
  if (t.includes(" ")) return t.length >= 7;
  return t.length >= 7;
}

function quote(term) {
  return term.includes(" ") ? `"${term}"` : term;
}

/**
 * Build Gmail full-text queries from the rules you already maintain, so
 * there's one list to keep up to date rather than two.
 */
export function buildBoostQueries(config) {
  const rules = config.rules || {};
  const scope = config.email?.boostScope || "in:inbox newer_than:14d";
  const byTier = new Map();

  const add = (tier, term) => {
    if (!isDistinctive(term)) return;
    if (!byTier.has(tier)) byTier.set(tier, new Set());
    byTier.get(tier).add(quote(term));
  };

  for (const p of rules.people || []) {
    if (!p.searchBody) continue;
    for (const m of p.match || []) add(p.tier, m);
  }
  for (const [topic, spec] of Object.entries(rules.topics || {})) {
    if (!spec.searchBody) continue;
    // bodyKeywords lets you hand-pick the terms that are safe to full-text
    // search. "facility" in a subject line is a useful hint; "facility"
    // anywhere in any body is half the inbox.
    for (const k of spec.bodyKeywords || spec.keywords || []) add(topic, k);
  }

  const max = config.email?.maxBoostTerms ?? 20;
  return [...byTier.entries()].map(([tier, terms]) => ({
    tier,
    query: `${scope} (${[...terms].slice(0, max).join(" OR ")})`,
  }));
}

/**
 * Score an email against the rules. Pure function, no API, no tokens.
 * `boosts` maps a message id to the tier a full-text query matched it on.
 */
export function triage(msg, rules, boosts = new Map()) {
  const from = String(msg.from || "").toLowerCase();
  const addr = senderAddress(msg.from);
  const subject = String(msg.subject || "");
  const haystack = `${from} ${subject} ${msg.snippet || ""}`.toLowerCase();

  const reasons = [];
  let score = 0;
  let tier = null;

  const bump = (s, t, reason) => {
    if (s > score) { score = s; tier = t; }
    reasons.push(reason);
  };

  // Hard mute — automated senders that never need a human.
  for (const m of rules.mute || []) {
    if (addr.includes(m.toLowerCase())) return { score: 0, tier: null, reasons: ["muted sender"] };
  }

  // Named people in the From header.
  for (const person of rules.people || []) {
    const hit = (person.match || []).some(
      (token) => hasToken(from, token) || addr.includes(token.toLowerCase())
    );
    if (hit) {
      bump(rules.tierScores?.[person.tier] ?? 80, person.tier, `from ${person.label}`);
      break;
    }
  }

  // Known domains.
  for (const d of rules.domains || []) {
    const m = d.match.toLowerCase();
    if (addr.endsWith(`@${m}`) || addr.endsWith(`.${m}`)) {
      bump(rules.tierScores?.[d.tier] ?? 80, d.tier, d.label);
      break;
    }
  }

  // Topic keywords in the visible header/preview text.
  for (const [topic, spec] of Object.entries(rules.topics || {})) {
    const hit = (spec.keywords || []).find((k) => hasToken(haystack, k));
    if (hit) bump(spec.score ?? 60, topic, `mentions "${hit}"`);
  }

  // Matched deep in the message body or a signature — this is the one that
  // catches "regards, Alex Fournier" at the bottom of an otherwise plain email.
  const boost = boosts.get(msg.id);
  if (boost) {
    bump(rules.tierScores?.[boost] ?? 80, boost, "body or signature match");
  }

  // Newsletters are dropped unless a person, domain or body rule claimed them.
  const claimed = ["family", "work", "opportunity"].includes(tier);
  if (msg.isNewsletter && !claimed) {
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
- A routine reminder that merely STATES a standing policy — a cancellation window, a late fee, a refund window, terms of service — is informational, not a request. Reading that policy is not an action the reader needs to take. Only set "needsReply" true, or invent a "dueAt", if the email is actually asking this specific reader to confirm, cancel, reschedule, or pay something — not because a policy or a date is merely mentioned somewhere in the text.
- "dueAt": an ISO date (YYYY-MM-DD) ONLY if the email states or clearly implies a deadline THIS reader must act by. Otherwise null. Never invent one, and never derive one from a policy window (e.g. "cancel 24h prior") unless the email is actually asking for a cancellation decision right now.
- "oneLine": under 90 characters. State what it is and what it wants, in that order — and if it wants nothing beyond "for your information", say that plainly rather than manufacturing a task. Do NOT restate the subject line verbatim — add the information the subject leaves out. Never begin with "This email", "You have", or the sender's name.
- Return exactly one result per email, in order, using the given "n".`;

// 3000 characters is generous for almost any real email (a deadline, a
// date, an ask is essentially always stated well before this), while still
// keeping the prompt's token cost bounded for the rare genuinely long one.
// Falls back to the snippet only if the full-body fetch itself failed for
// this particular message — see collectEmail()'s own `bodies.get(...)`.
const BODY_CHARS = 3000;

export function buildClassifyPrompt(candidates, todayISO) {
  const lines = candidates.map((c, i) =>
    [
      `${i + 1}. From: ${senderName(c.msg.from) || senderAddress(c.msg.from)}`,
      `   Subject: ${c.msg.subject}`,
      `   Body: ${(c.body || c.msg.snippet || "").slice(0, BODY_CHARS)}`,
    ].join("\n")
  );
  return `Today is ${todayISO}. Return json for these ${candidates.length} email(s).\n\n${lines.join("\n\n")}`;
}

export async function collectEmail(config, { force = false } = {}) {
  const rules = config.rules || {};
  const cfg = config.email || {};

  // --- 1 + 2: cheap id lists, including full-text body/signature matches ---
  const mainIds = await listMessageIds({
    query: cfg.query || "in:inbox newer_than:14d",
    maxResults: cfg.maxResults || 40,
  });

  const boosts = new Map();
  const boostQueries = buildBoostQueries(config);
  for (const bq of boostQueries) {
    try {
      const ids = await listMessageIds({ query: bq.query, maxResults: cfg.maxBoostResults || 20 });
      for (const id of ids) if (!boosts.has(id)) boosts.set(id, bq.tier);
      log.debug(`boost "${bq.tier}" matched ${ids.length}`);
    } catch (err) {
      log.warn(`boost query for ${bq.tier} failed: ${err.message}`);
    }
  }

  // Union, so an important message past the main cap is still caught.
  const allIds = [...new Set([...mainIds, ...boosts.keys()])];
  if (!allIds.length) {
    log.info("inbox query returned nothing");
    return [];
  }

  const seen = await knownMessageIds();
  const fresh = force ? allIds : allIds.filter((id) => !seen.has(id));

  log.info(
    `${mainIds.length} in list, ${boosts.size} by content, ${allIds.length} unique, ${fresh.length} new`
  );
  if (!fresh.length) return []; // the cheap path: zero further spend

  const messages = await getMessagesMetadata(fresh, { concurrency: 5 });
  await rememberMessageIds(fresh);

  // --- 5: deterministic triage. Free, and it removes most of the volume ---
  const minScore = cfg.minScore ?? 60;
  const candidates = [];
  for (const msg of messages) {
    const t = triage(msg, rules, boosts);
    if (t.score >= minScore) candidates.push({ msg, ...t });
  }

  log.info(`${candidates.length}/${messages.length} passed triage (min score ${minScore})`);
  if (!candidates.length) return [];

  // --- 6: full body, but ONLY for whatever survived triage above ---
  // A failed fetch for one message (a transient error, a deleted draft)
  // just means that one candidate falls back to its own snippet below —
  // never a reason to drop the whole batch.
  const bodies = await getMessagesBody(candidates.map((c) => c.msg.id), { concurrency: 5 });
  for (const c of candidates) c.body = bodies.get(c.msg.id) || "";

  // --- 7: one AI call for everything that survived, using real body text ---
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

  // --- build items; degrade gracefully if the model was unavailable ---
  return candidates.map((c, i) => {
    const ai = byN.get(i + 1) || {};
    const title = (ai.oneLine || c.msg.subject || "").toString().slice(0, 160);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(ai.dueAt || "") ? `${ai.dueAt}T23:59:00` : null;
    const needsReply = ai.needsReply === true;
    const who = senderName(c.msg.from) || senderAddress(c.msg.from);

    const category = categorise(
      { title: c.msg.subject, body: c.msg.snippet, tier: c.tier },
      config
    );

    // The title says what it wants; the detail says who it's from and why we
    // surfaced it. Neither repeats the other.
    const detail = [who, c.reasons[c.reasons.length - 1]].filter(Boolean).join(" · ");

    return {
      id: itemId("email", c.msg.threadId),
      source: "email",
      kind: needsReply ? "needs-reply" : "fyi",
      title,
      detail,
      url: `https://mail.google.com/mail/u/0/#inbox/${c.msg.threadId}`,
      dueAt: due,
      category: category.id,
      categoryLabel: category.label,
      categoryWeight: Math.max(category.weight, c.score >= 95 ? 48 : 0),
      domain: deriveDomain(
        { title: `${c.msg.subject} ${title}`, body: c.msg.snippet, category: category.id },
        config
      ),
      unmissable: Boolean(category.unmissable),
      emphasised: isEmphasised(c.msg.subject),
      tier: c.tier || "personal",
      reasons: c.reasons,
      contentHash: contentHash({ s: c.msg.subject, n: title, d: due, r: needsReply }),
      meta: { from: who, address: senderAddress(c.msg.from), subject: c.msg.subject, needsReply },
    };
  });
}
