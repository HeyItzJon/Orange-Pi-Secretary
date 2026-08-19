// sources/notes.js
//
// Loose threads: things you wrote down with intent and then stopped touching.
// Nothing else in your life surfaces these, which is why this is the section
// most likely to feel like the system actually knows you.
//
// v1 had a working vault walker that nothing ever imported. This is that idea
// finished: instead of counting open tasks, it reads the actual task text and
// only speaks up when a note is BOTH stale and unfinished.
//
// No AI. No network. Just the filesystem.

import fs from "fs/promises";
import path from "path";
import { logger } from "../lib/log.js";
import { itemId, contentHash } from "../lib/ids.js";

const log = logger("notes");
const IGNORE = new Set([".obsidian", ".trash", ".git", "node_modules", ".smart-env"]);

async function walk(dir, base, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE.has(e.name)) continue;
      await walk(path.join(dir, e.name), base, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const full = path.join(dir, e.name);
      try {
        const st = await fs.stat(full);
        out.push({
          name: e.name.replace(/\.md$/i, ""),
          full,
          rel: path.relative(base, full),
          mtime: st.mtime,
        });
      } catch { /* skip unreadable */ }
    }
  }
  return out;
}

function daysSince(d) {
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

/** First few unfinished checkboxes, with their text — the actual signal. */
async function openTasks(file, limit = 3) {
  try {
    const content = await fs.readFile(file, "utf-8");
    const found = [];
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s\[ \]\s+(.*\S)/);
      if (m) found.push(m[1].replace(/[*_`]/g, "").trim().slice(0, 140));
      if (found.length >= limit) break;
    }
    return found;
  } catch {
    return [];
  }
}

export async function collectNotes(config) {
  const cfg = config.notes || {};
  const vaultPath = cfg.vaultPath || config.vaultPath;
  if (!vaultPath) {
    log.warn("no vaultPath configured — skipping notes");
    return [];
  }

  const staleDays = cfg.staleDays ?? 10;
  const watch = (cfg.watchFolders || []).map((s) => s.toLowerCase());
  const maxItems = cfg.maxItems ?? 4;

  let files;
  try {
    files = await walk(vaultPath, vaultPath);
  } catch (err) {
    log.error(`vault unreadable: ${err.message}`);
    return [];
  }

  const inScope = files.filter((f) => {
    const rel = f.rel.toLowerCase().replace(/\\/g, "/");
    return watch.length === 0 || watch.some((w) => rel.includes(w));
  });

  const stale = inScope
    .map((f) => ({ ...f, age: daysSince(f.mtime) }))
    .filter((f) => f.age >= staleDays)
    .sort((a, b) => b.age - a.age);

  log.info(`${files.length} notes, ${inScope.length} in watched folders, ${stale.length} stale`);

  const items = [];
  for (const f of stale) {
    if (items.length >= maxItems) break;
    const tasks = await openTasks(f.full);
    if (!tasks.length) continue; // stale but finished — nothing to say

    items.push({
      id: itemId("note", f.rel),
      source: "note",
      kind: "loose-thread",
      title: `"${tasks[0]}"`,
      // The age already shows in the row's left column — don't say it twice.
      detail: `${f.name} · ${path.dirname(f.rel).replace(/\\/g, "/")}`,
      url: null,
      dueAt: null,
      category: "note",
      categoryLabel: "Loose thread",
      // Older = louder, but capped low so a note never outranks a real
      // deadline. These are nudges, not obligations.
      categoryWeight: Math.min(22, 12 + Math.floor(f.age / 7)),
      unmissable: false,
      emphasised: false,
      tier: "note",
      reasons: [`${tasks.length} open task${tasks.length > 1 ? "s" : ""}`, `stale ${f.age}d`],
      contentHash: contentHash({ t: tasks, a: Math.floor(f.age / 7) }),
      meta: { path: f.rel, age: f.age, tasks },
    });
  }

  return items;
}
