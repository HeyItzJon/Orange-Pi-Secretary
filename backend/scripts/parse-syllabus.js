// scripts/parse-syllabus.js
//
// Turns whatever syllabus PDFs you've dropped into
// backend/data/syllabi/ (config.brightspace.syllabiDir) into rows in the
// `courses` table — grade weightings and topic scope, read straight off
// the PDF text via one cached AI call per file. Manual and re-runnable, not
// on the 15-minute pull clock: syllabi are static files you drop in once a
// semester, not something worth re-checking constantly (same category as
// scripts/sync-holdings.js — a deliberate, occasional trigger, not a
// scheduled source).
//
//   node scripts/parse-syllabus.js
//   npm run parse-syllabi
//
// Course code detection, in order — see the Brightspace plan doc's own
// "open question" on this: filenames are the simplest and most reliable
// when you follow a convention (ELEC2507.pdf, case-insensitive), but
// nothing forces that convention, so this falls back to reading the code
// straight out of the PDF's own first page text, and finally to whatever
// the AI extraction call itself reports (it's asked for the course code
// too, as a last resort — most syllabi state it clearly on page one).
//
// Caching: every extraction call goes through lib/ai.js's own ask(), keyed
// by this exact file's content hash — so re-running this on unchanged PDFs
// costs nothing beyond the read+hash, even before this script's own
// "unchanged, skip entirely" check below (which only fires when a course
// code was already known from the filename or the raw text, i.e. before
// ever needing to call the AI at all).
//
// Nothing here ever runs during a normal 15-minute pull cycle, and nothing
// in sources/brightspace.js depends on this having been run — an
// unparsed/never-run syllabus set just means buildFacts() never has a
// `syllabus` block to show, same graceful-degradation shape every other
// optional fact in this app already follows.

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import { init, getCourse, setCourse } from "../lib/store.js";
import { extractCourseCode } from "../lib/classify.js";
import { contentHash, cacheKey } from "../lib/ids.js";
import { ask } from "../lib/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const config = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf-8"));
// config.brightspace.syllabiDir is written relative to the repo root (e.g.
// "backend/data/syllabi", matching how it reads in config.example.json) —
// resolved from ROOT's own parent so it means the same thing regardless of
// where this script is actually run from.
const SYLLABI_DIR = path.join(ROOT, "..", config.brightspace?.syllabiDir || "backend/data/syllabi");

await init();

const EXTRACT_SYSTEM = `You extract structured grading information from a university course syllabus's raw text.

Return json with this exact shape:
{"courseCode":"..." | null, "courseName":"..." | null, "weightings":[{"item":"...","weight":0,"notes":"..." | null}], "topics":[{"assessment":"...","chapters":"..." | null,"scope":"..." | null}]}

Rules:
- Extract ONLY what the text explicitly states. Never estimate, infer, or round a weight that isn't written down. If a section isn't in the text, return an empty array for it — never invent a plausible-sounding entry.
- "courseCode": the course's own code (e.g. "ELEC 2507"), if it's stated anywhere in the text — usually near the top. null if you can't find one stated.
- "weightings": one entry per graded component and its percentage of the final grade, exactly as stated (e.g. {"item":"Midterm Exam","weight":25,"notes":null}).
- "topics": one entry per exam/assignment the syllabus describes the scope of (e.g. {"assessment":"Final Exam","chapters":"Ch. 1-9","scope":"Cumulative, emphasis on Ch. 6-9"}). Leave chapters/scope null rather than guessing when the text doesn't say.
- No commentary, no markdown — the json object only.`;

/** Course code straight from a filename, case-insensitively — the simplest
 *  path when you name files ELEC2507.pdf/elec2507.pdf/etc. */
function fromFilename(name) {
  return extractCourseCode(name.toUpperCase());
}

async function parseOne(file) {
  const full = path.join(SYLLABI_DIR, file);
  const buf = await fs.readFile(full);
  const hash = contentHash(buf.toString("base64"));

  let courseCode = fromFilename(file);

  const { text } = await pdfParse(buf);
  if (!courseCode) courseCode = extractCourseCode(text.slice(0, 3000));

  // Already parsed, file hasn't changed since — skip the AI call entirely.
  // Only reachable when the code was already known before this point; see
  // this file's own header for why the AI-only-known-code path always
  // re-calls (still free on a cache hit, just not skipped at this earlier
  // stage).
  if (courseCode) {
    const existing = await getCourse(courseCode);
    if (existing?.syllabusHash === hash) {
      console.log(`  skip   ${file} — ${courseCode} unchanged since last parse`);
      return { file, courseCode, skipped: true };
    }
  }

  const key = cacheKey("syllabus-extract", { hash });
  const parsed = await ask({
    system: EXTRACT_SYSTEM,
    user: text.slice(0, 12000), // syllabi run long; the grading/schedule sections are almost always in the first several pages
    config,
    maxTokens: 1000,
    json: true,
    cacheAs: key,
  });

  if (!parsed) {
    console.log(`  FAIL   ${file} — AI extraction unavailable (provider off, or the call failed)`);
    return { file, courseCode, skipped: false, failed: true };
  }

  const finalCode = courseCode || (parsed.courseCode ? String(parsed.courseCode).toUpperCase().trim() : null);
  if (!finalCode) {
    console.log(`  FAIL   ${file} — no course code found in the filename, the text, or the AI's own read of it`);
    return { file, courseCode: null, skipped: false, failed: true };
  }

  await setCourse(finalCode, {
    courseName: parsed.courseName || null,
    weightings: Array.isArray(parsed.weightings) ? parsed.weightings : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    syllabusFile: file,
    syllabusHash: hash,
  });

  console.log(`  ok     ${file} -> ${finalCode} (${parsed.weightings?.length || 0} weightings, ${parsed.topics?.length || 0} topics)`);
  return { file, courseCode: finalCode, skipped: false, failed: false };
}

let files;
try {
  files = (await fs.readdir(SYLLABI_DIR)).filter((f) => f.toLowerCase().endsWith(".pdf"));
} catch (err) {
  if (err.code === "ENOENT") {
    console.log(`No syllabi folder yet at ${SYLLABI_DIR} — create it and drop PDFs in, then run this again.`);
    process.exit(0);
  }
  throw err;
}

if (!files.length) {
  console.log(`No PDFs found in ${SYLLABI_DIR}.`);
  process.exit(0);
}

console.log(`Parsing ${files.length} syllabus file${files.length === 1 ? "" : "s"}...\n`);

let ok = 0, skipped = 0, failed = 0;
for (const file of files) {
  try {
    const r = await parseOne(file);
    if (r.skipped) skipped++;
    else if (r.failed) failed++;
    else ok++;
  } catch (err) {
    console.log(`  FAIL   ${file} — ${err.message}`);
    failed++;
  }
}

console.log(`\n${ok} parsed, ${skipped} unchanged, ${failed ? `${failed} FAILED` : "0 failed"}\n`);
process.exit(failed ? 1 : 0);
