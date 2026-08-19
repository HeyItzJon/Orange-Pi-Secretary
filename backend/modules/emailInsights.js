// emailInsights.js
//
// Generates actionable insights from recent emails.
// Pulls last 10-15 emails, extracts key info, feeds to AI for insight generation.
// Returns array of insight objects: { text, priority, category: "email" }

import axios from "axios";
import { generateInsights } from "./aiClient.js";

/**
 * Exchange Gmail refresh token for a fresh access token.
 * Returns the access token string.
 */
async function getAccessToken() {
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Gmail credentials missing (.env needs GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)");
  }

  try {
    const response = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });

    return response.data.access_token;
  } catch (err) {
    throw new Error(`Failed to refresh Gmail token: ${err.response?.data?.error || err.message}`);
  }
}

/**
 * Fetch recent emails from Gmail.
 * Returns array of { from, subject, snippet, date, labels, threadContext }
 */
async function getRecentEmails(accessToken, maxResults = 20) {
  try {
    // 1. Get list of message IDs (fetch recent emails, read or unread)
    // Gmail sorts by recent by default. We exclude trash/spam but get all else.
    const listResponse = await axios.get(
      `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=-in:trash -in:spam`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const messageIds = listResponse.data.messages || [];
    if (messageIds.length === 0) {
      return [];
    }

    // 2. Fetch full message details for each ID
    const emails = await Promise.all(
      messageIds.map(async (msg) => {
        try {
          const fullMessage = await axios.get(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          // Extract headers from payload
          const headers = fullMessage.data.payload?.headers || [];
          const from = headers.find(h => h.name === "From")?.value || "Unknown";
          const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
          const date = headers.find(h => h.name === "Date")?.value || "";
          const snippet = fullMessage.data.snippet || "";
          const labels = fullMessage.data.labelIds || [];
          const threadId = fullMessage.data.threadId;

          // Get thread context to see conversation flow
          let threadContext = "";
          try {
            const thread = await axios.get(
              `https://www.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            // Collect snippets from last 2-3 messages in thread to show conversation flow
            const messages = thread.data.messages || [];
            if (messages.length > 1) {
              threadContext = messages
                .slice(-3) // last 3 messages
                .map(m => {
                  const mHeaders = m.payload?.headers || [];
                  const mFrom = mHeaders.find(h => h.name === "From")?.value || "Unknown";
                  const mSnippet = m.snippet || "";
                  return `${mFrom}: ${mSnippet}`;
                })
                .join(" | ");
            }
          } catch (threadErr) {
            // Thread fetch failed, just skip context
          }

          return { from, subject, snippet, date, labels, threadContext };
        } catch (innerErr) {
          console.error(`[emailInsights] Failed to fetch message ${msg.id}:`, innerErr.message);
          return null;
        }
      })
    );

    return emails.filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to fetch emails from Gmail: ${err.message}`);
  }
}

/**
 * Build prompt for email insight generation.
 * Summarizes recent emails into actionable themes.
 */
function buildEmailPrompt(emails) {
  let prompt = "## Recent Emails (Last 20)\n\n";

  emails.forEach((email, idx) => {
    prompt += `${idx + 1}. **From:** ${email.from}\n`;
    prompt += `   **Subject:** ${email.subject}\n`;
    prompt += `   **Latest:** ${email.snippet.substring(0, 150)}\n`;
    if (email.threadContext) {
      prompt += `   **Thread:** ${email.threadContext.substring(0, 200)}\n`;
    }
    prompt += "\n";
  });

  prompt += "Extract 1-3 actionable insights ONLY. Focus on:\n";
  prompt += "- DEADLINES or time-sensitive items\n";
  prompt += "- DECISIONS that need your input\n";
  prompt += "- OPPORTUNITIES or important updates\n";
  prompt += "- ACTIONS you need to take\n\n";
  prompt += "Skip emails where the user has clearly resolved the matter (replied with confirmation, completion, closure, or scheduling done).\n";
  prompt += "Be specific, not generic. Skip marketing unless directly relevant to your work.\n";

  return prompt;
}

/**
 * Generate email insights.
 * Returns array of insight objects: { text, priority, category: "email" }
 */
export async function generateEmailInsights(config) {
  try {
    // Get fresh access token
    const accessToken = await getAccessToken();

    // Fetch last 20 recent emails to give DeepSeek context on what's resolved
    const emails = await getRecentEmails(accessToken, 20);

    if (emails.length === 0) {
      console.log("[emailInsights] No unread emails found");
      return [];
    }

    console.log(`[emailInsights] Fetched ${emails.length} emails from Gmail`);

    // Build prompt
    const userPrompt = buildEmailPrompt(emails);

    // Use email-specific system prompt from config
    const emailConfig = {
      ...config,
      systemPrompt: config.emailSystemPrompt || "You are a smart email triage specialist. Extract 1-3 actionable themes from emails."
    };

    // Generate insights
    const rawInsights = await generateInsights(userPrompt, emailConfig);

    console.log(`[emailInsights] Generated ${rawInsights.length} raw insights from DeepSeek`);
    if (rawInsights.length === 0) {
      console.log("[emailInsights] Warning: DeepSeek returned no insights for email prompt");
    }

    // Mark as email insights and limit to 1-3
    return rawInsights
      .slice(0, 3)
      .map(insight => ({
        ...insight,
        category: "email"
      }));
  } catch (err) {
    console.error("[emailInsights] Error:", err.message);
    return [];
  }
}
