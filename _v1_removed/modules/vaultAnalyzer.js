// vaultAnalyzer.js
//
// Reads your ACTUAL Obsidian vault folder. No daily-notes assumption -
// instead it looks at file activity across the whole vault, and uses
// folder names ("Projects", "Research", etc.) as a loose hint for
// categorizing notes. It's intentionally generic so it doesn't break
// if your folder structure doesn't match some assumed convention.

import fs from "fs/promises";
import path from "path";

const IGNORE_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

async function walkVault(dir, baseDir) {
  let results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Could not read vault folder "${dir}". Check "vaultPath" in config.json. (${err.message})`);
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results = results.concat(await walkVault(path.join(dir, entry.name), baseDir));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.stat(fullPath);
      results.push({
        name: entry.name.replace(/\.md$/i, ""),
        fullPath,
        relativePath: path.relative(baseDir, fullPath),
        lastModified: stat.mtime
      });
    }
  }
  return results;
}

function daysSince(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

async function countOpenTasks(fullPath) {
  try {
    const content = await fs.readFile(fullPath, "utf-8");
    const matches = content.match(/^\s*-\s\[ \]/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

/**
 * config.vaultPath - full path to your Obsidian vault folder
 * config.staleDaysThreshold - a note is "stale" if untouched this many days (default 5)
 * config.projectFolderHint / researchFolderHint - substrings (case-insensitive)
 *   used to loosely classify notes by their folder path. Adjust these in
 *   config.json to match how you actually organize your vault.
 */
export async function getVaultSummary(config) {
  const vaultPath = config.vaultPath;
  if (!vaultPath) {
    throw new Error('vaultPath is not set in config.json. Add: "vaultPath": "C:\\\\path\\\\to\\\\your\\\\vault"');
  }

  const staleDays = config.staleDaysThreshold || 5;
  const projectHint = (config.projectFolderHint || "project").toLowerCase();
  const researchHint = (config.researchFolderHint || "research").toLowerCase();

  const files = await walkVault(vaultPath, vaultPath);
  const withAge = files.map(f => ({ ...f, daysSinceEdit: daysSince(f.lastModified) }));

  const isProjectLike = f => f.relativePath.toLowerCase().includes(projectHint);
  const isResearchLike = f => f.relativePath.toLowerCase().includes(researchHint);

  const staleProjectFiles = withAge.filter(f => isProjectLike(f) && f.daysSinceEdit >= staleDays);
  const staleProjects = [];
  for (const f of staleProjectFiles) {
    const openTasks = await countOpenTasks(f.fullPath);
    staleProjects.push({ name: f.name, lastEdited: `${f.daysSinceEdit} days ago`, openTasks });
  }

  const activeResearch = withAge
    .filter(isResearchLike)
    .sort((a, b) => a.daysSinceEdit - b.daysSinceEdit)
    .slice(0, 6)
    .map(f => ({ name: f.name, lastEdited: `${f.daysSinceEdit} days ago` }));

  // General activity pattern, since there's no daily-notes streak to use.
  const editedLast7Days = withAge.filter(f => f.daysSinceEdit <= 7).length;
  const editedPrevious7Days = withAge.filter(f => f.daysSinceEdit > 7 && f.daysSinceEdit <= 14).length;
  const untouched30PlusDays = withAge.filter(f => f.daysSinceEdit >= 30).length;

  return {
    totalNotes: files.length,
    staleProjects,
    activeResearch,
    activitySummary: {
      notesEditedLast7Days: editedLast7Days,
      notesEditedPrevious7Days: editedPrevious7Days,
      notesUntouched30PlusDays: untouched30PlusDays
    }
  };
}
