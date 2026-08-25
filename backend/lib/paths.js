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
