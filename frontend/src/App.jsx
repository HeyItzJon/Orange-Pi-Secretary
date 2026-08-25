// App.jsx — one screen, two tiers.
//
//   Today  a chronological timeline of the whole day, domains mixed and
//          tagged, because that's the shape of a day.
//   Lanes  School · Work · Career · Finance · Social · Projects · Personal —
//          everything else, grouped by where your attention goes.
//
// Nothing is capped and nothing is silently dropped. Repeated, undated items
// are folded behind a labelled toggle; the only things excluded entirely are
// ones you marked done, dismissed or snoozed, events that already happened,
// and dates beyond the horizon — and every one of those is listed at the
// bottom with its reason.

import { useCallback, useEffect, useMemo, useState } from "react";
import TodayTimeline from "./components/TodayTimeline.jsx";
import Lane from "./components/Lane.jsx";
import Legend from "./components/Legend.jsx";
import "./App.css";

// Must match SCHEMA in backend/brief/rules.js. If the server sends something
// else, this bundle is stale — which otherwise looks exactly like data loss.
const SCHEMA = "lanes-v1";

const POLL_MS = 5 * 60 * 1000;

const FILTERS = [
  { id: "all", label: "Everything" },
  { id: "action", label: "Needs you" },
  { id: "new", label: "New" },
];

// Which source feeds each lane — shown next to the lane title so it's never a
// mystery where a row came from.
const LANE_SOURCE = {
  school: "calendar · email",
  work: "calendar · email",
  career: "email",
  finance: "holdings · vault",
  social: "calendar",
  projects: "calendar",
  personal: "calendar · email",
};

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
  const [filter, setFilter] = useState("all");
  const [showExcluded, setShowExcluded] = useState(false);

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
      if (failed.length) setError(failed.map(([n, r]) => `${n}: ${r.error}`).join(" · "));
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

  const sections = brief?.sections || {};
  const order = brief?.order || [];
  const labels = brief?.domainLabels || {};
  const stale = brief && brief.schema !== SCHEMA;

  const matches = useCallback(
    (item) => {
      if (filter === "action") return item._needsAction;
      if (filter === "new") return item._new || item._changed;
      return true;
    },
    [filter]
  );

  const dateLine = useMemo(() => {
    if (!brief) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: brief.timezone, weekday: "long", month: "long", day: "numeric",
    }).format(new Date(brief.generatedAt));
  }, [brief]);

  const visibleInLanes = useMemo(
    () => order.reduce((n, d) => n + (sections[d] || []).filter(matches).length, 0),
    [order, sections, matches]
  );

  const counts = brief?.counts || {};

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

      {stale && (
        <div className="banner">
          <b>This page is out of date.</b> The server is sending{" "}
          <code>{brief.schema || "an unknown format"}</code> but this build understands{" "}
          <code>{SCHEMA}</code>. Rebuild the frontend and hard-refresh:
          <code className="cmd">cd frontend &amp;&amp; npm run build</code>
          Until you do, most of your items won't appear here.
        </div>
      )}

      {!brief && !error && <div className="empty"><p>Loading…</p></div>}

      {brief && !stale && (
        <>
          <div className="mast">
            <h1>{dateLine}</h1>
            <div className="sub">
              Updated {fmtTime(brief.generatedAt, brief.timezone)} ·{" "}
              <b>{counts.today ?? 0} today</b> · <b>{counts.lanes ?? 0} tracked</b>
              {counts.needsAction > 0 && ` · ${counts.needsAction} need you`}
              {counts.new > 0 && ` · ${counts.new} new`}
            </div>
            {brief.summary && <p className="summary">{brief.summary}</p>}
          </div>

          <div className="filters">
            {FILTERS.map((f) => {
              const n =
                f.id === "all"
                  ? counts.lanes ?? 0
                  : order.reduce(
                      (acc, d) =>
                        acc +
                        (sections[d] || []).filter((i) =>
                          f.id === "action" ? i._needsAction : i._new || i._changed
                        ).length,
                      0
                    );
              return (
                <button
                  key={f.id}
                  className="ctl chipbtn"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}{n > 0 ? ` (${n})` : ""}
                </button>
              );
            })}
          </div>

          {/* Never filtered — it's the schedule, not a list. */}
          <TodayTimeline
            items={sections.today}
            timezone={brief.timezone}
            domainLabels={labels}
          />

          {order.map((d) => (
            <Lane
              key={d}
              id={d}
              label={labels[d] || d}
              source={LANE_SOURCE[d]}
              items={(sections[d] || []).filter(matches)}
              money={d === "finance" ? brief.money : null}
              timezone={brief.timezone}
              onAction={act}
              busyIds={busyIds}
              filtered={filter !== "all"}
            />
          ))}

          {visibleInLanes === 0 && (
            <div className="empty">
              <p>
                {filter === "all"
                  ? "Nothing outside today is being tracked yet. Hit Refresh."
                  : "Nothing matches that filter."}
              </p>
              {filter !== "all" && (
                <button className="ctl" onClick={() => setFilter("all")}>Show everything</button>
              )}
            </div>
          )}

          <Legend />

          {counts.excluded > 0 && (
            <section className="excluded">
              <button className="quiet-toggle" onClick={() => setShowExcluded(!showExcluded)}>
                {showExcluded ? "▾" : "▸"} {counts.excluded} not shown
                <span className="quiet-why"> — and exactly why</span>
              </button>
              {showExcluded && (
                <ul className="excluded-list">
                  {(brief.excluded || []).map((e) => (
                    <li key={e.id}>
                      <span className="ex-title">{e.title}</span>
                      <span className="ex-why">{e.why}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <div className="foot">
            {Object.entries(brief.sources || {}).map(([name, at]) => (
              <span key={name}>
                {name} {fmtTime(at, brief.timezone)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
