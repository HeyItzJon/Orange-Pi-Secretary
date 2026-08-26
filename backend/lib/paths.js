// lib/paths.js
//
// One thing: a leading "~" means nothing to Node. That expansion is a shell
// convention — fs and path don't do it, so `path.join("~/Obsidian", ...)`
// tries to open a literal folder named "~" and fails, silently, wherever
// nothing checks for that specific case. config.vault.path is the one
// config value that carries this risk (see config.example.json), so every
// read of it goes through here first instead of trusting the raw string.

import os from "os";
import path from "path";

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Where to find the vault, resolved the same way everywhere it's read —
 * sources/money.js's real read path and scripts/doctor.js's diagnostic both
 * used to duplicate this same `config.vault?.path || ...` chain, which is
 * how they drifted out of sync once before.
 *
 * config.json is tracked in git (see Round 33 — Jon wants `git pull` alone
 * to bring over a working setup), which means vault.path travels between
 * machines with every pull. That's fine as long as every machine's vault
 * lives at the same path, but it doesn't: Jon's Windows machine and the Pi
 * are never going to agree on one path, Windows-style or Linux-style. A
 * commit made after testing on Windows lands a Windows path in config.json,
 * a `git pull` on the Pi carries that Windows path over even though nothing
 * there could ever resolve it, and the vault check starts failing with no
 * code change on the Pi's side at all — just a config value that was right
 * for a different machine.
 *
 * VAULT_PATH in `.env` — never tracked, always machine-local — is checked
 * first for exactly that reason: every machine gets to keep its own real
 * path permanently, immune to whatever config.json says after the next
 * pull. Falls back to config.json's vault.path (or the older
 * notes.vaultPath/vaultPath spellings) when no override is set, so a
 * single-machine setup that's never needed one keeps working unchanged.
 * `~` still gets expanded either way (see expandHome above).
 */
export function resolveVaultPath(config) {
  if (process.env.VAULT_PATH) {
    return { path: expandHome(process.env.VAULT_PATH), source: "VAULT_PATH env var", raw: process.env.VAULT_PATH };
  }
  const raw = config.vault?.path || config.notes?.vaultPath || config.vaultPath;
  return { path: expandHome(raw), source: "config.json", raw };
}
