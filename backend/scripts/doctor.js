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
const vaultPath = config.vault?.path || config.notes?.vaultPath || config.vaultPath;
if (!vaultPath) {
  warn("no vaultPath set — holdings will fall back to config/portfolio.json");
} else {
  try {
    await fs.access(vaultPath);
    ok(`vault reachable: ${vaultPath}`);
  } catch (err) {
    bad(`vault: ${err.message}`);
  }
}

// ---- portfolio ----------------------------------------------------------
console.log("\nPortfolio");
try {
  const p = JSON.parse(await fs.readFile(path.join(root, "config", "portfolio.json"), "utf-8"));
  const n = (p.holdings || []).length;
  n ? ok(`${n} holdings`) : warn("portfolio.json has no holdings (fine if your holdings live in the vault instead)");
  const withTargets = (p.holdings || []).filter((h) => h.targetPct != null).length;
  if (!withTargets) warn("no targetPct on any holding — drift alerts disabled");
} catch (err) {
  warn(`portfolio.json: ${err.message} (fine if your holdings live in the vault instead)`);
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
