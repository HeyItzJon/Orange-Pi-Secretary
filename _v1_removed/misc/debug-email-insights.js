#!/usr/bin/env node

import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

async function getAccessToken() {
  try {
    console.log("   Client ID:", process.env.GMAIL_CLIENT_ID?.substring(0, 20) + "...");
    console.log("   Has refresh token:", !!process.env.GMAIL_REFRESH_TOKEN);

    const response = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    });
    return response.data.access_token;
  } catch (err) {
    console.error("Token exchange error details:");
    console.error("   Status:", err.response?.status);
    console.error("   Full response:", JSON.stringify(err.response?.data, null, 2));
    throw err;
  }
}

async function getRecentEmails(accessToken, maxResults = 5) {
  const listResponse = await axios.get(
    `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=-in:trash -in:spam`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const messageIds = listResponse.data.messages || [];
  if (messageIds.length === 0) return [];

  const emails = await Promise.all(
    messageIds.map(async (msg) => {
      const fullMessage = await axios.get(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const headers = fullMessage.data.payload?.headers || [];
      const from = headers.find(h => h.name === "From")?.value || "Unknown";
      const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
      const snippet = fullMessage.data.snippet || "";

      return { from, subject, snippet };
    })
  );

  return emails.filter(Boolean);
}

async function debug() {
  console.log("Debugging email insights...\n");

  try {
    console.log("1. Fetching emails...");
    const accessToken = await getAccessToken();
    const emails = await getRecentEmails(accessToken, 20);
    console.log(`Got ${emails.length} emails\n`);

    if (emails.length === 0) {
      console.log("No emails to test with");
      process.exit(1);
    }

    console.log("2. Email subjects:");
    emails.forEach((email, idx) => {
      console.log(`   ${idx + 1}. FROM: ${email.from.substring(0, 40)}`);
      console.log(`      SUBJ: ${email.subject.substring(0, 60)}`);
    });
    console.log();

    let prompt = "## Recent Emails\n\n";
    emails.forEach((email, idx) => {
      prompt += `${idx + 1}. **From:** ${email.from}\n`;
      prompt += `   **Subject:** ${email.subject}\n`;
      prompt += `   **Snippet:** ${email.snippet.substring(0, 150)}\n\n`;
    });
    prompt += "Extract 1-3 actionable insights ONLY. Focus on time-sensitive items, decisions needed, important updates. Skip marketing. Example: 'Meeting Friday about contract.'\n";

    console.log("3. Calling DeepSeek...");
    const response = await axios.post(
      "https://api.deepseek.com/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "You are a smart email triage specialist. Extract 1-3 actionable themes from emails. Focus on: time-sensitive items (deadlines, decisions), important opportunities, business updates, or personal actions. Be direct and specific. Skip generic marketing unless it's directly relevant. Example: 'Team meeting Friday—bring Q3 budget draft' or 'New vendor pricing proposal—compare against current contract.' Respond ONLY with a JSON array. Each item: {\"category\": \"action\"|\"deadline\"|\"update\"|\"decision\", \"text\": string, \"priority\": \"high\"|\"medium\"|\"low\"}."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("4. Raw response from DeepSeek:");
    const rawContent = response.data.choices[0].message.content;
    console.log(rawContent);
    console.log();

    try {
      // Strip markdown code fences if present
      let jsonContent = rawContent.trim();
      if (jsonContent.startsWith("```")) {
        jsonContent = jsonContent.replace(/^```json\n/, "").replace(/\n```$/, "");
      }
      const parsed = JSON.parse(jsonContent);
      console.log(`5. Parsed: ${parsed.length} insights found`);
      if (parsed.length > 0) {
        parsed.forEach((item, idx) => {
          console.log(`   ${idx + 1}. [${item.priority}] ${item.text}`);
        });
      } else {
        console.log("   (DeepSeek returned empty - emails may not be actionable)");
      }
    } catch (parseErr) {
      console.log(`5. Parse failed: ${parseErr.message}`);
    }
  } catch (err) {
    console.error("Error:", err.response?.data?.error || err.message);
  }
}

debug();
