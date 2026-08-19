// App.jsx — the whole dashboard is one screen: the brief.
//
// v1 had six tabs, three of which were the same component with a different
// filter. This replaces all of them. The archive of everything the system
// knows is still available at /api/items; the screen shows only what today
// needs.

import { useCallback, useEffect, useMemo, useState } from "react";
import Section from "./components/Section.jsx";
import MoneyPanel from "./components/MoneyPanel.jsx";
import "./App.css";

const SECTION_ORDER = [
  ["today", "Today"],
  ["needsYou", "Needs you"],
  ["newSince", "New since yesterday"],
  ["comingUp", "Coming up"],
];

// The brief changes a few times a day, not every minute. v1 polled every 60s
// for data that regenerated every 2 hours; five minutes is plenty.
const POLL_MS = 5 * 60 * 1000;

/** en-CA renders "11:04 a.m."; the brief uses "11:04 AM" everywhere. */
function fmtTime(iso, timeZone) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  })
    .format(new Date(iso))
    .replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export default function App() {
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIds, setBusyIds] = useState(new Set());
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const load = useCallback(async () => {
    try {
      setBrief(await api("/api/brief"));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api("/api/refresh", { method: "POST", body: JSON.stringify({}) });
      setBrief(res.brief);
      const failed = Object.entries(res.report || {}).filter(([, r]) => !r.ok);
      if (failed.length) {
        setError(failed.map(([name, r]) => `${name}: ${r.error}`).join(" · "));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function act(id, action) {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await api(`/api/items/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "snooze" ? { days: 3 } : {}),
      });
      setBrief(res.brief);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const dateLine = useMemo(() => {
    if (!brief) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: brief.timezone,
      weekday: "long", month: "long", day: "numeric",
    }).format(new Date(brief.generatedAt));
  }, [brief]);

  const generatedLine = useMemo(
    () => (brief ? fmtTime(brief.generatedAt, brief.timezone) : ""),
    [brief]
  );

  const sections = brief?.sections || {};
  const moneyItems = sections.money || [];
  const emptyNames = useMemo(() => {
    const all = [...SECTION_ORDER.map(([k, l]) => [k, l]), ["money", "Money"], ["looseThreads", "Loose threads"]];
    return all.filter(([k]) => !sections[k]?.length && !(k === "money" && brief?.money)).map(([, l]) => l);
  }, [sections, brief]);

  return (
    <div className="wrap">
      <div className="topbar">
        <span className={`status grow${error ? " err" : ""}`}>
          {error || (refreshing ? "Checking everything…" : "")}
        </span>
        <button className="ctl primary" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button className="ctl" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </div>

      {!brief && !error && <div className="empty"><p>Loading…</p></div>}

      {brief && (
        <>
          <div className="mast">
            <h1>{dateLine}</h1>
            <div className="sub">
              Brief generated {generatedLine} · <b>{brief.counts.total} item{brief.counts.total === 1 ? "" : "s"}</b>
              {brief.counts.new > 0 ? ` · ${brief.counts.new} new since yesterday` : " · nothing new"}
            </div>
            {brief.summary && <p className="summary">{brief.summary}</p>}
          </div>

          {SECTION_ORDER.map(([key, label]) => (
            <Section
              key={key}
              title={label}
              items={sections[key]}
              timezone={brief.timezone}
              onAction={act}
              busyIds={busyIds}
              showCount={key !== "today"}
            />
          ))}

          <MoneyPanel
            money={brief.money}
            items={moneyItems}
            timezone={brief.timezone}
            onAction={act}
            busyIds={busyIds}
          />

          <Section
            title="Loose threads"
            items={sections.looseThreads}
            timezone={brief.timezone}
            onAction={act}
            busyIds={busyIds}
          />

          {brief.counts.total === 0 && (
            <div className="empty">
              <p>Nothing needs you right now.</p>
              <button className="ctl" onClick={refresh} disabled={refreshing}>Check again</button>
            </div>
          )}

          {brief.counts.total > 0 && emptyNames.length > 0 && (
            <div className="note">
              {emptyNames.join(" · ")} — empty, so hidden.
            </div>
          )}

          <div className="foot">
            <span>{brief.counts.hidden} held back</span>
            {Object.entries(brief.sources || {}).map(([name, at]) => (
              <span key={name}>{name} {fmtTime(at, brief.timezone)}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
