import { weekForecast, filterLive, isTaskLike } from "./brief/display.js";

const now = new Date("2026-09-13T15:00:00-04:00");
const items = [
  {
    id: "cal:1", source: "calendar", status: "open", kind: "today",
    title: "Team sync", dueAt: "2026-09-13T14:00:00-04:00",
    swatch: "work", detail: "Weekly standup · 10 min walk · 3 people",
    meta: { end: "2026-09-13T14:30:00-04:00", allDay: false, busyLevel: "busy" },
  },
  {
    id: "cal:2", source: "calendar", status: "open", kind: "today",
    title: "Lecture", dueAt: "2026-09-13T09:00:00-04:00",
    swatch: "school", detail: "MC 4050",
    meta: { end: "2026-09-13T10:20:00-04:00", allDay: false },
  },
  {
    id: "cal:3", source: "calendar", status: "open", kind: "today",
    title: "All day thing", dueAt: "2026-09-13T00:00:00-04:00",
    swatch: "personal", detail: "",
    meta: { allDay: true },
  },
];

const today = "2026-09-13";
const todayEvents = items
  .filter((i) => i.source === "calendar" && i.dueAt?.startsWith(today) && i.status === "open")
  .map((e) => {
    const hasRealDuration = e.meta?.end && !e.meta?.allDay;
    const dur = hasRealDuration
      ? Math.min(600, Math.max(5, Math.round((new Date(e.meta.end) - new Date(e.dueAt)) / 60000)))
      : 30;
    return {
      time: e.clockTime || e.dueAt?.slice(11, 16) || "",
      title: (e.title || "").slice(0, 30),
      busyLevel: e.meta?.busyLevel || "medium",
      cal: e.swatch || "",
      dur,
      desc: (e.detail || "").slice(0, 60),
    };
  })
  .sort((a, b) => a.time.localeCompare(b.time));

console.log("todayEvents:", JSON.stringify(todayEvents, null, 2));

const liveItems = filterLive(items, now);
const calendarEvents = liveItems
  .filter((i) => i.source === "calendar" && i.dueAt && i.kind !== "system")
  .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
const todayForecast = weekForecast(calendarEvents, liveItems.filter(isTaskLike), {
  now, tz: "America/Toronto", days: 1,
}).days[0];
console.log("dayOverview:", { hoursBusy: todayForecast?.busyHours ?? 0, hoursFree: todayForecast?.freeHours ?? 0 });
