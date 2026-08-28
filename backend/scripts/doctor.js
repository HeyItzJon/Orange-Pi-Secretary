// scripts/doctor.js
//
// Checks everything that can quietly be wrong, and says so in plain language.
// Run this first whenever the brief looks empty or off.
//
//   npm run doctor

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { resolveVaultPath } from "../lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

console.log("\nSecretary doctor\n");

// ---- config -------------------------------------------------------------
let config;
try {
  config = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf-8"));
  ok("config.json parses");
} catch (err) {
  if (err.code === "ENOENT") {
    bad("config.json not found — this is the first thing to fix");
    console.log("\n        Run:  cp config.example.json config.json");
    console.log("        Then edit it: calendars, people who matter, vault path.");
    console.log("        config.json is gitignored, so your real names stay local.\n");
  } else {
    bad(`config.json: ${err.message}`);
  }
  process.exit(1);
}

// ---- environment --------------------------------------------------------
console.log("\nEnvironment");
for (const key of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) {
  process.env[key] ? ok(key) : bad(`${key} missing from .env`);
}
const provider = config.ai?.provider;
if (provider === "off") {
  warn("AI provider is 'off' — briefs will render without a summary line");
} else if (provider === "deepseek") {
  process.env.DEEPSEEK_API_KEY ? ok("DEEPSEEK_API_KEY") : bad("DEEPSEEK_API_KEY missing");
} else if (provider === "claude") {
  process.env.ANTHROPIC_API_KEY ? ok("ANTHROPIC_API_KEY") : bad("ANTHROPIC_API_KEY missing");
}

// ---- google -------------------------------------------------------------
console.log("\nGoogle");
try {
  const { getAccessToken, resolveCalendars } = await import("../lib/google.js");
  await getAccessToken();
  ok("OAuth token exchange");

  const { matched, missing, available } = await resolveCalendars(config.calendar?.targets || [], { force: true });
  ok(`${matched.length} of ${(config.calendar?.targets || []).length} calendars resolved`);
  for (const m of matched) console.log(`          · ${m.summary}`);
  if (missing.length) {
    bad(`not found: ${missing.join(", ")}`);
    console.log(`          available: ${available.join(" | ")}`);
  }
} catch (err) {
  bad(`Google: ${err.message}`);
}

// ---- gmail --------------------------------------------------------------
console.log("\nGmail");
try {
  const { listMessageIds } = await import("../lib/google.js");
  const ids = await listMessageIds({ query: config.email?.query || "in:inbox", maxResults: 5 });
  ok(`inbox query returned ${ids.length} message(s)`);
} catch (err) {
  bad(`Gmail query: ${err.message}`);
}

// ---- vault ----------------------------------------------------------------
// The vault is no longer a task/event source — this just confirms the path
// resolves, because money.js still reads it directly for holdings (share
// counts, book value). No task/loose-thread scanning happens here anymore.
console.log("\nVault");
const { path: vaultPath, source: vaultPathSource, raw: rawVaultPath } = resolveVaultPath(config);
if (!vaultPath) {
  warn("no vaultPath set — holdings will fall back to config/portfolio.json");
} else {
  try {
    await fs.access(vaultPath);
    ok(vaultPath === rawVaultPath
      ? `vault reachable: ${vaultPath} (from ${vaultPathSource})`
      : `vault reachable: ${vaultPath} (expanded from "${rawVaultPath}", from ${vaultPathSource})`);
  } catch (err) {
    // config.json is tracked in git (see lib/paths.js's own comment on
    // resolveVaultPath) — a path that's right on one machine and wrong on
    // this one, right after a `git pull`, is the single most likely reason
    // this fails, not a typo. Naming the source here is what makes that
    // obvious instead of a mystery ENOENT.
    bad(`vault: ${err.message} (path came from ${vaultPathSource}${vaultPathSource === "config.json" ? " — set VAULT_PATH in .env on this machine to override it" : ""})`);
  }
}

// ---- portfolio ----------------------------------------------------------
// The real, current book is the SQLite `holdings` table (synced from the
// vault — see sources/money.js's syncHoldings, Round 23). config/portfolio.json
// below is read separately, straight off disk, purely as a last-resort
// fallback file for when BOTH the vault AND that synced cache are
// unreachable — its own holding count has no reason to match the real one,
// and reporting only IT here (as this used to) is exactly what made the
// doctor's count look wrong next to the real, live Finances page: this file
// can go stale indefinitely since nothing ever re-derives it from anything
// live, while the real book keeps itself current on every sync.
console.log("\nPortfolio");
try {
  const { init: initStore, getHoldings } = await import("../lib/store.js");
  await initStore();
  const holdings = await getHoldings();
  holdings.length
    ? ok(`${holdings.length} holdings in the synced book (this is the real count the app actually uses)`)
    : warn("no holdings synced yet — run `npm run sync-holdings`, or start the server once");
} catch (err) {
  warn(`could not read the synced holdings table: ${err.message}`);
}

try {
  const p = JSON.parse(await fs.readFile(path.join(root, "config", "portfolio.json"), "utf-8"));
  const n = (p.holdings || []).length;
  ok(`fallback file present: ${n} holding(s) (only ever used if the vault AND the synced cache above both fail — a different count here from the real book is expected, not a bug)`);
  const withTargets = (p.holdings || []).filter((h) => h.targetPct != null).length;
  if (n && !withTargets) warn("no targetPct on any holding in the fallback file — drift alerts would be disabled if this file were ever actually used");
} catch (err) {
  warn(`portfolio.json: ${err.message} (fine if your holdings live in the vault instead — this file is only a last-resort fallback)`);
}

// ---- quotes ---------------------------------------------------------------
// Hits Yahoo directly, ticker by ticker, so a stale price on the Finances
// page has a real answer instead of a guess. Two failure shapes read very
// differently here, deliberately:
//   1. EVERY ticker fails with the same "no set-cookie header" / crumb-type
//      error — that's Yahoo's own auth flow breaking (a known, recurring
//      yahoo-finance2 issue, sometimes tied to how Yahoo's EU consent
//      redirect responds to a given IP), nothing wrong with any one holding.
//   2. ONE ticker fails while the rest succeed — that's the real signal a
//      specific symbol is wrong, delisted, or a listing Yahoo just doesn't
//      carry reliable data for (small NEO/Cboe Canada CDR listings are the
//      most likely case in this book).
// Also reports what's CURRENTLY cached for each ticker (moneySummary/
// priceCache), since a live failure right now doesn't by itself explain how
// old the price actually showing on screen is.
console.log("\nQuotes");
try {
  const { init: initStore, getHoldings, getMeta } = await import("../lib/store.js");
  await initStore();
  const holdings = await getHoldings();
  if (!holdings.length) {
    warn("no holdings to check — see Portfolio above");
  } else {
    const YahooFinance = (await import("yahoo-finance2")).default;
    const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
    const priceCache = (await getMeta("priceCache", {})) || {};
    const moneySummary = await getMeta("moneySummary", null);

    let liveFailures = 0;
    for (const h of holdings) {
      const cached = priceCache[h.ticker];
      const cacheNote = cached
        ? ` (cache: ${cached.price} ${cached.currency} as of ${cached.quotedAt})`
        : " (nothing cached for this ticker yet)";
      try {
        const q = await yahoo.quote(h.ticker);
        if (q?.regularMarketPrice != null) {
          ok(`${h.ticker}: live ${q.regularMarketPrice} ${q.currency || "?"} (${q.marketState || "unknown state"})`);
        } else {
          liveFailures++;
          bad(`${h.ticker}: Yahoo returned no price for this symbol${cacheNote}`);
        }
      } catch (err) {
        liveFailures++;
        bad(`${h.ticker}: ${err.message}${cacheNote}`);
      }
    }
    if (liveFailures === holdings.length && holdings.length > 1) {
      warn("every ticker failed the same way — this points at Yahoo's own auth/consent flow, not any one holding. Try again in a few minutes; if it persists, yahoo-finance2 may need an update.");
    }
    if (moneySummary?.stale?.length) {
      warn(`moneySummary currently marks stale: ${moneySummary.stale.join(", ")} (showing last-known price rather than live)`);
    }
    if (moneySummary?.unavailable?.length) {
      bad(`moneySummary currently marks unavailable (no price at all, ever): ${moneySummary.unavailable.join(", ")}`);
    }
  }
} catch (err) {
  bad(`quotes check: ${err.message}`);
}

// ---- frontend -----------------------------------------------------------
console.log("\nFrontend");
try {
  await fs.access(path.join(root, "..", "frontend", "dist", "index.html"));
  ok("frontend/dist is built");
} catch {
  bad("frontend/dist missing — run `npm run build` in /frontend, or localhost:3001 will 404");
}

console.log(`\n${failures ? `${failures} problem(s) found.` : "All clear."}\n`);
process.exit(failures ? 1 : 0);
