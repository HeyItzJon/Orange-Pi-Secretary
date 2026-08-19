#!/usr/bin/env node

import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

async function getAccessToken() {
  try {
    console.log("🔑 Exchanging refresh token for access token...");
    const response = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    });
    console.log("✓ Access token received\n");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Token exchange failed:", err.response?.data?.error_description || err.message);
    console.error("\nIf error is 'invalid_grant', refresh token expired. Need to re-authenticate.");
    throw err;
  }
}

async function getAllCalendars(accessToken) {
  try {
    console.log("📚 Fetching all available calendars...\n");

    const response = await axios.get(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const calendars = response.data.items || [];
    console.log(`Found ${calendars.length} calendars:\n`);

    calendars.forEach((cal, idx) => {
      console.log(`   ${idx + 1}. ${cal.summary}`);
      console.log(`      ID: ${cal.id}`);
      console.log(`      Primary: ${cal.primary || false}`);
      if (cal.description) console.log(`      ${cal.description}`);
    });

    return calendars;
  } catch (err) {
    console.error("❌ Failed to list calendars:", err.response?.data?.error?.message || err.message);
    throw err;
  }
}

async function getCalendarEvents(accessToken, calendarId = "primary") {
  try {
    console.log(`\n📅 Fetching events from calendar: ${calendarId}...`);

    // Get events from the next 7 days
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const response = await axios.get(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          maxResults: 10,
          timeMin: now.toISOString(),
          timeMax: in7Days.toISOString(),
          orderBy: "startTime",
          singleEvents: true
        }
      }
    );

    const events = response.data.items || [];
    console.log(`✓ Got ${events.length} events`);

    if (events.length === 0) {
      console.log("   (No events in next 7 days)");
      return [];
    }

    events.forEach((event, idx) => {
      const start = new Date(event.start.dateTime || event.start.date);
      const title = event.summary || "(no title)";
      const attendees = event.attendees?.length || 0;
      console.log(`   ${idx + 1}. ${start.toLocaleDateString()} ${start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${title}`);
      if (attendees > 0) console.log(`      (${attendees} attendees)`);
    });

    return events;
  } catch (err) {
    console.error(`❌ Failed to fetch events from ${calendarId}:`, err.response?.data?.error?.message || err.message);
    return [];
  }
}

async function test() {
  try {
    const accessToken = await getAccessToken();

    // Get all calendars
    const calendars = await getAllCalendars(accessToken);

    // Fetch events from each calendar
    console.log("\n" + "=".repeat(60));
    console.log("📋 EVENTS BY CALENDAR");
    console.log("=".repeat(60));

    for (const calendar of calendars) {
      await getCalendarEvents(accessToken, calendar.id);
    }

    console.log("\n✅ Calendar API is working!");
    console.log("If you're missing calendars, make sure they're shared to your Google account.");
  } catch (err) {
    console.error("\n❌ Test failed. See errors above.");
    process.exit(1);
  }
}

test();
