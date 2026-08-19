// calendarInsights.js
//
// Generates actionable insights from upcoming calendar events.
// Scans specific calendars for the next 5 days, extracts key events,
// feeds to AI for insight generation.
// Returns array of insight objects: { text, priority, category: "calendar" }

import axios from "axios";
import { generateInsights } from "./aiClient.js";

// Calendars to monitor
const TARGET_CALENDARS = [
  "jon.m.bourget@gmail.com",
  "IMPORTANT EVENTS",
  "Tests & Quizzes",
  "School & Classes",
  "WORK",
  "Sydney's Demands",
  "CANNOT MISS"
];

/**
 * Exchange Gmail refresh token for a fresh access token.
 * Returns the access token string.
 */
async function getAccessToken() {
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Google credentials missing (.env needs GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)");
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
    throw new Error(`Failed to refresh Google token: ${err.response?.data?.error || err.message}`);
  }
}

/**
 * Get all available calendars and find the ones we want to monitor.
 * Returns array of { id, summary }
 */
async function getTargetCalendars(accessToken) {
  try {
    const response = await axios.get(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const allCalendars = response.data.items || [];

    // Find calendars that match our target list (case-insensitive)
    const targetCals = allCalendars.filter(cal =>
      TARGET_CALENDARS.some(target =>
        cal.summary.toLowerCase() === target.toLowerCase()
      )
    );

    if (targetCals.length === 0) {
      console.warn("[calendarInsights] Warning: None of the target calendars found");
    } else {
      console.log(`[calendarInsights] Found ${targetCals.length} target calendars: ${targetCals.map(c => c.summary).join(", ")}`);
    }

    return targetCals;
  } catch (err) {
    throw new Error(`Failed to fetch calendar list: ${err.message}`);
  }
}

/**
 * Fetch events from target calendars for the next 5 days.
 * Returns array of { summary, start, end, description, calendarName, attendees }
 */
async function getUpcomingEvents(accessToken, calendars) {
  try {
    const now = new Date();
    const in5Days = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    // Fetch events from all target calendars in parallel
    const eventPromises = calendars.map(cal =>
      axios.get(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            maxResults: 50,
            timeMin: now.toISOString(),
            timeMax: in5Days.toISOString(),
            orderBy: "startTime",
            singleEvents: true
          }
        }
      ).then(res => ({
        calendarName: cal.summary,
        events: res.data.items || []
      })).catch(err => {
        console.error(`[calendarInsights] Failed to fetch from ${cal.summary}:`, err.message);
        return { calendarName: cal.summary, events: [] };
      })
    );

    const results = await Promise.all(eventPromises);

    // Flatten and enrich events with calendar name
    const allEvents = results.flatMap(result =>
      result.events.map(event => ({
        summary: event.summary || "(no title)",
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        description: event.description || "",
        calendarName: result.calendarName,
        attendees: event.attendees?.length || 0
      }))
    );

    // Sort by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    console.log(`[calendarInsights] Fetched ${allEvents.length} events from ${calendars.length} calendars`);
    return allEvents;
  } catch (err) {
    throw new Error(`Failed to fetch events: ${err.message}`);
  }
}

/**
 * Build prompt for calendar insight generation.
 * Summarizes upcoming events into actionable themes.
 */
function buildCalendarPrompt(events) {
  if (events.length === 0) {
    return "No upcoming events in the next 5 days.";
  }

  let prompt = "## Your Calendar: Next 5 Days\n\n";

  // Group events by day for readability
  const byDay = {};
  events.forEach(event => {
    const date = new Date(event.start).toLocaleDateString();
    if (!byDay[date]) byDay[date] = [];
    byDay[date].push(event);
  });

  Object.entries(byDay).forEach(([date, dayEvents]) => {
    prompt += `### ${date}\n`;
    dayEvents.forEach((event, idx) => {
      const time = new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      prompt += `${idx + 1}. **${event.summary}** (${time})\n`;
      prompt += `   Calendar: ${event.calendarName}\n`;
      if (event.attendees > 0) prompt += `   Attendees: ${event.attendees}\n`;
      if (event.description) prompt += `   Notes: ${event.description.substring(0, 100)}\n`;
    });
    prompt += "\n";
  });

  prompt += "Extract 1-5 actionable insights. Focus on:\n";
  prompt += "- Upcoming important events or deadlines\n";
  prompt += "- Days that are packed/busy with back-to-back events\n";
  prompt += "- Events from CANNOT MISS or IMPORTANT EVENTS calendars\n";
  prompt += "- Time conflicts or overlaps\n";
  prompt += "- Events needing prep or prep time\n\n";
  prompt += "Be specific. Example: 'Tuesday packed: 4 events, 8am-6pm. Schedule buffer time between 2-3pm class and 4pm work meeting.'\n";

  return prompt;
}

/**
 * Generate calendar insights.
 * Returns array of insight objects: { text, priority, category: "calendar" }
 */
export async function generateCalendarInsights(config) {
  try {
    // Get fresh access token
    const accessToken = await getAccessToken();

    // Find target calendars
    const calendars = await getTargetCalendars(accessToken);

    if (calendars.length === 0) {
      console.log("[calendarInsights] No target calendars found");
      return [];
    }

    // Fetch events
    const events = await getUpcomingEvents(accessToken, calendars);

    if (events.length === 0) {
      console.log("[calendarInsights] No upcoming events found");
      return [];
    }

    console.log(`[calendarInsights] Analyzing ${events.length} events`);

    // Build prompt
    const userPrompt = buildCalendarPrompt(events);

    // Use calendar-specific system prompt from config
    const calendarConfig = {
      ...config,
      systemPrompt: config.calendarSystemPrompt || "You are a smart calendar assistant. Extract 1-5 actionable themes from upcoming events. Focus on important events, busy days, and prep needed."
    };

    // Generate insights
    const rawInsights = await generateInsights(userPrompt, calendarConfig);

    console.log(`[calendarInsights] Generated ${rawInsights.length} raw insights`);

    // Mark as calendar insights and limit to 5
    return rawInsights
      .slice(0, 5)
      .map(insight => ({
        ...insight,
        category: "calendar"
      }));
  } catch (err) {
    console.error("[calendarInsights] Error:", err.message);
    return [];
  }
}
