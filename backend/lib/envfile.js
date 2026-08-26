// lib/envfile.js
//
// One thing: update a single KEY=value line in a .env file in place,
// preserving every other line untouched — without pulling in a full .env
// parser/serializer for what's really a one-line edit.
//
// Written for scripts/get-refresh-token.js, which used to just print the
// new token and ask for a manual copy-paste into .env — exactly the step
// that mangled a refresh token once already (a long value line-wraps in a
// terminal, and however it got copied from there landed a truncated or
// corrupted value in the file). Editing the file directly removes that
// failure mode entirely; anything else that ever needs to hand a fresh
// credential to .env without a manual paste step can reuse this too.

import fs from "fs/promises";

/**
 * Replaces the first `KEY=...` line in the file at `envPath` with
 * `KEY=value`, or appends it if the key isn't present yet. Backs up
 * whatever was there before overwriting — this writes credentials, so a
 * bad write here should never be an unrecoverable one.
 */
export async function writeEnvValue(envPath, key, value) {
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (raw) await fs.writeFile(`${envPath}.bak`, raw, "utf-8");

  const pattern = new RegExp(`^${key}=`);
  let found = false;
  const lines = raw.split(/\r?\n/).map((line) => {
    if (pattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  // A file ending in a newline splits into one extra trailing "" element —
  // drop it (and any others) unconditionally before deciding what to write,
  // so the join below always adds back exactly one trailing newline rather
  // than doubling up when the original file already had one.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!found) lines.push(`${key}=${value}`);
  await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");
}
