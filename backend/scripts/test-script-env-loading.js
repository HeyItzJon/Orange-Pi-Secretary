// scripts/test-script-env-loading.js
//
// A real bug this guards against: scripts/sync-holdings.js called
// syncHoldings() -> holdingsFromVault() -> resolveVaultPath(), which reads
// process.env.VAULT_PATH, but the script itself never ran `import
// "dotenv/config"` — so .env was never loaded, VAULT_PATH was always
// undefined, and resolveVaultPath() silently fell back to whatever stale
// path config.json happened to carry (right on whichever machine last
// edited it, wrong everywhere else). The failure mode was quiet: the vault
// read threw ENOENT, syncHoldings() caught it and fell back to the last
// cached copy, and the script printed a normal-looking "synced N holdings
// from cache" table — nothing about that output screams "this didn't
// actually read the vault." (See also scripts/parse-syllabus.js, which had
// the same gap against DEEPSEEK_API_KEY, though lib/ai.js at least throws
// a clear AIUnavailable rather than silently substituting old data.)
//
// server.js and every source file it eventually calls into never had this
// problem — server.js loads dotenv once at process start, and everything
// downstream (sources/money.js, lib/ai.js, lib/google.js,
// sources/brightspace.js) just reads whatever's already in process.env by
// the time it runs. The bug is specific to standalone one-off scripts:
// each is its OWN node process, so each is responsible for loading .env
// itself before anything downstream reads process.env.
//
// This doesn't run the scripts — it just proves, by reading their source,
// that any script importing from one of the env-reading modules also loads
// dotenv somewhere. A cheap, permanent tripwire against the same class of
// bug creeping back in on the next new script.
//
// Run: node scripts/test-script-env-loading.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const group = (t) => console.log(`\n${t}\n`);
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;

// Modules that read process.env directly somewhere in their own body —
// anything importing one of these, at the top level, needs .env loaded
// before it runs. Kept as a short, explicit list rather than trying to
// trace the whole import graph — good enough to catch the real cases
// (money/vault, ai/AI keys, google/gmail+calendar, brightspace/ICS url)
// without the complexity of a real static analyzer.
const ENV_READING_MODULES = [
  "sources/money.js",
  "lib/ai.js",
  "lib/google.js",
  "sources/brightspace.js",
  // sources/marketNews.js doesn't read process.env itself, but it calls
  // lib/marketTake.js's getMarketTake(), which calls lib/ai.js's ask() for
  // the once-a-day "Today's take" sentence — same indirect shape
  // sources/money.js already has via lib/paths.js's VAULT_PATH read.
  "sources/marketNews.js",
];

group("every standalone script that needs .env actually loads it");

const files = fs.readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith(".js") && !f.startsWith("test-"));

for (const file of files) {
  const full = path.join(SCRIPTS_DIR, file);
  const src = fs.readFileSync(full, "utf-8");

  const importsEnvReadingModule = ENV_READING_MODULES.some((m) => {
    const base = m.replace(/\.js$/, "");
    // Matches a static `from "../lib/ai.js"` (or without the extension) —
    // deliberately NOT matching a dynamic `await import(...)` call, since
    // by the time that runs, the script's own top-level code (including
    // any `import "dotenv/config"`) has already executed.
    const re = new RegExp(`from ["'](\\.\\./)+${base.replace(/\//g, "/")}(\\.js)?["']`);
    return re.test(src);
  });

  if (!importsEnvReadingModule) continue;

  test(`${file} imports something that reads process.env, so it must load dotenv itself`, () => {
    assert.ok(
      /import\s+["']dotenv\/config["']/.test(src),
      `${file} statically imports an env-reading module but has no 'import "dotenv/config"' — .env vars it needs (VAULT_PATH, DEEPSEEK_API_KEY, GMAIL_*, BRIGHTSPACE_ICS_URL) would silently be undefined when run standalone via node/npm run`
    );
  });
}

test("this test actually found and checked at least one real script — not silently a no-op", () => {
  assert.ok(files.length > 5, `expected several scripts in ${SCRIPTS_DIR}, found ${files.length}`);
});

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
