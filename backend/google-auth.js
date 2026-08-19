#!/usr/bin/env node

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import axios from "axios";
import open from "open";
import { URLSearchParams } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREDENTIALS_PATH = path.join(__dirname, "..", "backend", "client_secret.json");
const ENV_PATH = path.join(__dirname, "..", "backend", ".env");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

async function authorize() {
  // Read credentials
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`❌ Credentials file not found at: ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const redirectUri = redirect_uris[0];

  // Generate auth URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.append("client_id", client_id);
  authUrl.searchParams.append("redirect_uri", redirectUri);
  authUrl.searchParams.append("response_type", "code");
  authUrl.searchParams.append("scope", "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly");
  authUrl.searchParams.append("access_type", "offline");
  authUrl.searchParams.append("prompt", "consent");

  console.log("\n🔐 Google Authorization (Gmail + Calendar)\n");
  console.log("1. Browser will open");
  console.log("2. Log in and click 'Allow' (requesting Gmail + Calendar access)");
  console.log("3. Copy the 'code' from the URL");
  console.log("4. Paste it here\n");

  await open(authUrl.toString());
  console.log("🌐 Browser opened. Waiting...\n");

  const code = await question("Paste the auth code: ");

  if (!code || code.trim().length === 0) {
    console.error("❌ No code provided.");
    rl.close();
    process.exit(1);
  }

  try {
    console.log("\n⏳ Exchanging code for token...");

    // Exchange code for token using raw HTTP
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const params = new URLSearchParams({
      client_id,
      client_secret,
      code: code.trim(),
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const response = await axios.post(tokenUrl, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const refreshToken = response.data.refresh_token;

    console.log("\n📊 Response from Google:");
    console.log(JSON.stringify(response.data, null, 2));

    if (!refreshToken) {
      console.error("\n❌ No refresh token in response!");
      console.error("This usually means you already authorized this app.");
      console.error("Revoke access at: https://myaccount.google.com/permissions");
      rl.close();
      process.exit(1);
    }

    // Save to .env
    let envContent = "";
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, "utf-8");
      envContent = envContent
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("GMAIL_REFRESH_TOKEN=") &&
            !line.startsWith("GMAIL_CLIENT_ID=") &&
            !line.startsWith("GMAIL_CLIENT_SECRET=")
        )
        .join("\n");
    }

    envContent += `\nGMAIL_CLIENT_ID=${client_id}\nGMAIL_CLIENT_SECRET=${client_secret}\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
    fs.writeFileSync(ENV_PATH, envContent);

    console.log("\n✅ Success!");
    console.log("📝 Saved to .env:");
    console.log("   - GMAIL_CLIENT_ID");
    console.log("   - GMAIL_CLIENT_SECRET");
    console.log("   - GMAIL_REFRESH_TOKEN (with Gmail + Calendar scopes)");
    console.log("\n🎉 Ready to use Google services in your briefings!");

    rl.close();
  } catch (err) {
    console.error("\n❌ Error:", err.response?.data || err.message);
    rl.close();
    process.exit(1);
  }
}

authorize();
