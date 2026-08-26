// scripts/set-deepseek-key.js
//
// Paste a new DEEPSEEK_API_KEY straight into backend/.env — no nano, no
// hand-editing a file that also holds other secrets alongside it. Same
// reasoning as scripts/get-refresh-token.js: a value that's ever retyped
// by hand into an editor is a value that can get truncated or mangled
// along the way, so this writes it directly instead.
//
// Use this whenever the DeepSeek key gets rotated, revoked, or hits a
// billing/quota wall — generate a new one at
// https://platform.deepseek.com/api_keys, then run this.
//
//   node scripts/set-deepseek-key.js
//
// This checks the new key against DeepSeek's API for real before telling
// you to restart, so a bad paste or a key that's already been revoked
// shows up right here instead of surfacing later as a silent missing
// summary line in the brief.
//
// Same shape would work for ANTHROPIC_API_KEY too, if that ever needs the
// same treatment — swap ENV_KEY and the verification call below.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import { stdin, stdout } from "process";
import axios from "axios";
import { writeEnvValue } from "../lib/envfile.js";
import { cleanSecret } from "../lib/secretValue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");
const ENV_KEY = "DEEPSEEK_API_KEY";

console.log("\nGet a new key at https://platform.deepseek.com/api_keys if you don't have");
console.log("one ready yet.\n");

const rl = readline.createInterface({ input: stdin, output: stdout });
const pasted = await rl.question(`Paste the new ${ENV_KEY}: `);
rl.close();

const value = cleanSecret(pasted);
if (!value) {
  console.error("\nNothing pasted — .env left unchanged.\n");
  process.exit(1);
}

await writeEnvValue(ENV_PATH, ENV_KEY, value);
console.log(`\nSaved — ${ENV_KEY} in backend/.env now holds the new key.`);
console.log("(The previous .env was backed up to .env.bak, just in case.)");

console.log("\nChecking it against DeepSeek...");
try {
  await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    },
    {
      headers: { Authorization: `Bearer ${value}`, "Content-Type": "application/json" },
      timeout: 15000,
    }
  );
  console.log("\nVerified — DeepSeek accepted the new key. Restart the service to pick it up");
  console.log("everywhere:\n");
  console.log("  sudo systemctl restart pi-secretary\n");
  process.exit(0);
} catch (err) {
  const reason =
    err.response?.data?.error?.message || err.response?.statusText || err.message;
  console.error(`\nSaved it, but a live check failed: ${reason}`);
  if (err.response?.status === 401) {
    console.error("That's an auth error — double check the key was copied in full, or that");
    console.error("it hasn't already been revoked on the DeepSeek dashboard.\n");
  } else {
    console.error("Worth investigating before restarting the service on it.\n");
  }
  process.exit(1);
}
