// Display.jsx — the screen at /display
//
// Four pages, one question each: Today, Tasks, Money, Year. This is a website
// you open on a laptop or a phone, not a panel on a shelf, so it has a
// cursor, it responds to hover, and every list is something you can act on
// rather than only read.
//
// The refresh button is the one genuinely interactive thing here, and it earns
// its place: it reruns the pipeline and then SAYS WHAT EACH SOURCE DID. A
// dashboard that can't tell you it stopped talking to Gmail is worse than no
// dashboard, because you trust it.

import { useCallback, useEffect, useRef, useState } from "react";
import "./Display.css";

const SCHEMA = "display-v2";
const POLL_MS = 60 * 1000;              // cheap: recomputed from the local store
const SELF_HEAL_COOLDOWN = 30 * 60 * 1000;

const money = (n) => `$${Math.round(n).toLocaleString("en-CA")}`;
const signed = (n, dp = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}`;

// Same shape as the backend's own clockLabel (brief/display.js) — h:mm AM/PM,
// uppercase — with seconds added, since this is the one clock on the page
// that's actually supposed to be seen ticking.
const liveClockLabel = (date, timeZone) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).format(date).replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);

/* ==================================================================== bits */

/** The one clock on the page that actually runs — everything else here is
 *  "as of the last pull", which is the more honest number almost everywhere
 *  else, but the header wanted something that visibly moves. */
function LiveClock({ timeZone }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="liveclock">{liveClockLabel(now, timeZone)}</span>;
}

function Strip({ strip }) {
  if (!strip) return null;
  return (
    <div className="strip-wrap">
      <div className="strip">
        {(strip.ticks || []).map((t) => (
          <div key={t.hour} className={`tick${t.major ? " major" : ""}`} style={{ left: `${t.left}%` }} />
        ))}
        {strip.chunks.map((c) => (
          <div key={c.label} className="chunk-sep" style={{ left: `${c.left}%` }} />
        ))}
        {strip.blocks.map((b) => (
          <div
            key={b.id}
            className={`blk d-${b.swatch}${b.important ? " imp" : ""}${b.past ? " past" : ""}${b.left > 62 ? " flip" : ""}`}
            style={{ left: `${b.left}%`, width: `${b.width}%` }}
          >
            {b.label && (
              <span className="bl">
                {b.label}
                {b.time && <em>{b.time}</em>}
              </span>
            )}
            {/* A twenty-minute gap is two pixels wide. Hover is how it gets to
                say what it is without stealing room from the events that fit. */}
            {b.detail && (
              <span className="card">
                <b>{b.detail.title}</b>
                <span className="crange">
                  {b.detail.range}
                  {b.detail.duration && <> · {b.detail.duration}</>}
                </span>
                {b.detail.where && <span className="cwhere">{b.detail.where}</span>}
                {b.detail.prep && <span className="cprep">{b.detail.prep}</span>}
                {b.detail.priority && <span className="cpri">{b.detail.priority}</span>}
              </span>
            )}
          </div>
        ))}
        <div className="nowline" style={{ left: `${strip.nowPct}%` }} />
      </div>
      <div className="chunks">
        {(strip.ticks || []).filter((t) => t.label).map((t) => (
          <span key={t.hour} className="hr" style={{ left: `${t.left}%` }}>{t.label}</span>
        ))}
        {strip.chunks.map((c) => (
          <span key={c.label} className="chunk" style={{ left: `${c.left}%`, width: `${c.width}%` }}>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* =================================================================== pages */

function TodayPage({ d }) {
  return (
    <>
      <div className={`hero${d.hero.urgent ? "" : " calm"}`}>
        <span className="lbl">{d.hero.urgent ? "NOW" : "NEXT"}</span>
        <span className="big">{d.hero.lead}</span>
        {d.hero.sub && <span className="sub">{d.hero.sub}</span>}
      </div>

      <Strip strip={d.strip} />

      <div className="cols">
        <section className="zone">
          <h2>Rest of today</h2>
          {d.today.length === 0 ? (
            <p className="empty">Nothing left on the calendar.</p>
          ) : (
            d.today.map((t) => (
              <div className="trow" key={t.id}>
                <span className="t">{t.time}</span>
                <span className="body">
                  <span className="title">{t.title}</span>
                  {t.priority && <span className="pri">{t.priority}</span>}
                  {(t.where || t.duration || t.prep) && (
                    <span className="meta">
                      {[t.where, t.duration].filter(Boolean).join(" · ")}
                      {t.prep && <span className="prep">{t.prep}</span>}
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </section>

        <section className="zone">
          <h2>Next {d.days.length} days</h2>
          <div className="days">
            {d.days.map((day) => (
              <div className="day" key={day.key}>
                <div className="dhead">
                  <span className="dname">{day.label}</span>
                  <span className="ddate">{day.dateLabel}</span>
                </div>
                {day.clear ? (
                  <p className="empty">Clear.</p>
                ) : (
                  day.items.map((it) => (
                    <div className="drow" key={it.id}>
                      <span className="dt">{it.chunk || it.time}</span>
                      <span className="dbody">
                        <span className="title">{it.title}</span>
                        {it.priority && <span className="pri">{it.priority}</span>}
                        {(it.where || it.duration) && (
                          <span className="meta">
                            {[it.time !== it.chunk ? it.time : null, it.duration, it.where]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * What you owe. Two things make this different from the list it replaces:
 *
 *   - Every row can be answered. Done, or not-for-me — and answering one is
 *     instant, not a wait for a network round trip, so the list actually
 *     gets shorter as you clear it instead of lagging behind you.
 *   - The rows the model picked out carry a next action, not a restatement.
 *     "Email CPRT about an Altium seat" beats "Resolve Altium licensing".
 */
function TasksPage({ d, onAct }) {
  const { tasks, deadlines, priorities } = d;
  const [busy, setBusy] = useState(null);
  // Anything in "Start here" is already on the page. Repeating it in the
  // buckets below was the exact clutter this page is supposed to remove.
  const promoted = new Set((priorities || []).map((p) => p.id));

  const act = async (id, action) => {
    setBusy(id);
    await onAct(id, action);
    setBusy(null);
  };

  const Row = ({ t }) => (
    <div className={`task${t.unmissable ? " must" : ""}${t.top ? " top" : ""}${busy === t.id ? " busy" : ""}`}>
      <span className={`dot d-${t.domain}`} />
      <span className="tbody">
        {/* The action first when there is one — that's the line you act on. */}
        <span className="title">{t.do || t.title}</span>
        {t.do && <span className="from">{t.title}</span>}
        <span className="meta">
          <span className="origin">{t.originLabel}</span>
          {t.context && <> · {t.context}</>}
          {t.age >= 7 && <> · sat {t.age}d</>}
          {t.dateLabel && <> · {t.dateLabel}</>}
        </span>
        {t.why && <span className="why">{t.why}</span>}
      </span>
      {t.due && (
        <span className={`when${t.daysOut !== null && t.daysOut <= 1 ? " soon" : ""}`}>{t.due}</span>
      )}
      {/* Teaching it to shut up is the whole point: dismissed things stop
          coming back, and done ones stop counting. */}
      <span className="acts">
        <button className="act ok" title="done" onClick={() => act(t.id, "done")}>✓</button>
        <button className="act no" title="not relevant" onClick={() => act(t.id, "dismiss")}>✕</button>
      </span>
    </div>
  );

  return (
    <div className="page-tasks">
      <div className="tcol">
        {priorities?.length > 0 && (
          <section className="tgroup focus">
            <h2>Start here<em>{priorities.length}</em></h2>
            {priorities.map((p, i) => (
              <div className="focusrow" key={p.id}>
                <span className="n">{i + 1}</span>
                <span className="tbody">
                  <span className="title">{p.do || p.title}</span>
                  {p.why && <span className="why">{p.why}</span>}
                  <span className="meta">{p.note || (p.source === "calendar" ? "Calendar" : p.source === "email" ? "Email" : "Brightspace")}</span>
                </span>
                <span className="acts">
                  <button className="act ok" title="done" onClick={() => act(p.id, "done")}>✓</button>
                  <button className="act no" title="not relevant" onClick={() => act(p.id, "dismiss")}>✕</button>
                </span>
              </div>
            ))}
          </section>
        )}

        {tasks.total === 0 ? (
          <p className="empty big-empty">
            Nothing owed that the system can see. Check the sources panel if that feels wrong.
          </p>
        ) : (
          tasks.groups.map((g) => ({ ...g, items: g.items.filter((t) => !promoted.has(t.id)) }))
            .filter((g) => g.items.length)
            .map((g) => (
            <section className={`tgroup${g.urgent ? " urgent" : ""}`} key={g.key}>
              <h2>{g.label}<em>{g.items.length + g.hidden}</em></h2>
              {g.items.map((t) => <Row t={t} key={t.id} />)}
              {g.hidden > 0 && <p className="more">+{g.hidden} more</p>}
            </section>
          ))
        )}
      </div>

      <div className="tside">
        <section className="zone">
          <h2>Deadlines</h2>
          {deadlines.length === 0 ? (
            <p className="empty">Nothing with a date on it.</p>
          ) : (
            deadlines.map((x) => (
              <div className={`dl${x.near ? " near" : ""}`} key={x.id}>
                <span className="dlhead">
                  <span className="in">{x.in}</span>
                  <span className="on">{x.dateLabel}</span>
                </span>
                <span className="what">{x.title}</span>
                {x.note && <span className="dlnote">{x.note}</span>}
              </div>
            ))
          )}
        </section>

        <section className="zone">
          <h2>Where these come from</h2>
          <div className="origins">
            {[
              ["calendar", "Calendar"],
              ["email", "Email"],
              ["brightspace", "Brightspace"],
            ].map(([k, label]) => (
              <div className={`orow${tasks.counts[k] ? "" : " off"}`} key={k}>
                <span>{label}</span>
                <span>{tasks.counts[k] ? `${tasks.counts[k]}` : "not connected"}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The book. Every position, priced in one currency, sorted by what it's
 * actually worth.
 *
 * The list is not configured anywhere — it follows the vault's holding notes,
 * so buying something new means writing a note, not editing this file.
 */
function MoneyPage({ d }) {
  const p = d.portfolio;
  const [sort, setSort] = useState("value");

  if (!p) return <p className="empty big-empty">No portfolio pulled yet — press refresh, or open Sources.</p>;

  const cur = (n) => `$${Math.round(n).toLocaleString("en-CA")}`;

  const Movers = ({ list, dir }) => (
    <div className="mgrid">
      {list.length === 0 ? <p className="empty">None.</p> : list.map((m) => (
        <div className={`mrow ${dir}`} key={m.ticker}>
          <span className="tk">{m.ticker}</span>
          <span className="pc">{signed(m.pct, 2)}%</span>
          {/* The dollar figure is the one that decides whether you care. */}
          {m.value != null && <span className="wt">{signed(m.value, 0).replace(/^([+-])/, "$1$")}</span>}
        </div>
      ))}
    </div>
  );

  const sorted = [...p.positions].sort((a, b) => {
    if (sort === "day") return (b.dayChangePct ?? -999) - (a.dayChangePct ?? -999);
    if (sort === "return") return (b.totalReturnPct ?? -999) - (a.totalReturnPct ?? -999);
    return (b.value ?? -1) - (a.value ?? -1);
  });

  const COLS = [
    ["value", "Value"],
    ["day", "Today"],
    ["return", "Return"],
  ];

  return (
    <div className="page-money">
      <div className="mhead">
        <div className="mtotal">
          <span className="val">{cur(p.total)}</span>
          <span className="ccy">{p.base}</span>
          <span className={`chg ${p.dayPct >= 0 ? "up" : "down"}`}>
            {signed(p.dayPct)}% today
            {p.dayValue != null && <em>{signed(p.dayValue, 0).replace(/^([+-])/, "$1$")}</em>}
          </span>
        </div>
        <div className="mspan">
          <span><b>{p.weekPct != null ? `${signed(p.weekPct, 1)}%` : "—"}</b> week</span>
          <span><b>{p.monthPct != null ? `${signed(p.monthPct, 1)}%` : "—"}</b> month</span>
          <span><b>{p.holdingCount}</b> holdings</span>
          {p.fx?.USD && <span><b>{p.fx.USD.toFixed(4)}</b> USD/CAD</span>}
          {/* Standardized backend-side (sources/money.js's marketStatusLabel)
              to one of five phrases: pre-market, markets open, US markets
              open, TSX open, post-market — never Yahoo's raw enum
              lowercased, which is how "market postpost" happened. */}
          {p.marketStatus && <span className="quiet">{p.marketStatus}</span>}
        </div>
      </div>

      {/* A price that didn't refresh is the only thing here you must not
          trust, so it is named rather than reduced to a count. */}
      {(p.staleTickers.length > 0 || p.missingTickers.length > 0) && (
        <p className="mwarn">
          {p.staleTickers.length > 0 && <>Last price is old for <b>{p.staleTickers.join(", ")}</b>. </>}
          {p.missingTickers.length > 0 && <>No quote at all for <b>{p.missingTickers.join(", ")}</b>.</>}
        </p>
      )}

      <div className="mcols">
        <section className="zone">
          <h2>Up today</h2>
          <Movers list={p.up} dir="up" />
          <h2 className="spaced">Down today</h2>
          <Movers list={p.down} dir="down" />

          {/* A ticker related to what's already held, that might help fill
              a thin sector — see backend/lib/stockIdeas.js. Real Yahoo
              similarity data plus real sector weights, refreshed weekly;
              never an AI pitch, never a verdict. Empty until the first
              refresh actually runs — `npm run refresh-stock-idea` forces
              one immediately instead of waiting out the TTL. */}
          {(p.stockIdea || []).length > 0 && (
            <>
              <h2 className="spaced">Worth a look</h2>
              <div className="ideas">
                {p.stockIdea.map((c) => (
                  <div className="idea" key={c.ticker}>
                    <div className="idea-head">
                      <span className="tk">{c.ticker}</span>
                      {c.name && <span className="nm">{c.name}</span>}
                    </div>
                    {/* Yahoo doesn't have a business-summary blurb for every
                        ticker — say so rather than just leaving a silent gap
                        where the description should be. Same rule the
                        sources panel already follows for a dead feed. */}
                    {c.summary ? (
                      <p className="idea-summary">{c.summary}</p>
                    ) : (
                      <p className="idea-summary none">No business summary from Yahoo for this one.</p>
                    )}
                    {c.reason && <p className="idea-why">{c.reason}. Not investment advice.</p>}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="zone positions">
          <h2>
            All positions<em>{p.positions.length}</em>
            <span className="sortby">
              {COLS.map(([k, label]) => (
                <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{label}</button>
              ))}
            </span>
          </h2>
          <div className="ptable">
            <div className="phead">
              <span>Ticker</span><span>Value</span><span>Weight</span><span>Today</span><span>Return</span>
            </div>
            {sorted.map((x) => (
              <div className={`prow${x.stale ? " stale" : ""}`} key={x.ticker} title={x.name || x.ticker}>
                <span className="tk">
                  {x.display}
                  {x.currency !== p.base && <em>{x.currency}</em>}
                </span>
                <span className="v">{x.value != null ? cur(x.value) : "—"}</span>
                <span className="w">
                  <i style={{ width: `${Math.min(100, (x.weightPct ?? 0) * 3)}%` }} />
                  <b>{x.weightPct != null ? `${x.weightPct.toFixed(1)}%` : "—"}</b>
                </span>
                <span className={`d ${(x.dayChangePct ?? 0) >= 0 ? "up" : "down"}`}>
                  {x.dayChangePct != null ? `${signed(x.dayChangePct, 2)}%` : "—"}
                </span>
                <span className={`r ${(x.totalReturnPct ?? 0) >= 0 ? "up" : "down"}`}>
                  {x.totalReturnPct != null ? `${signed(x.totalReturnPct, 0)}%` : "—"}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The year, big: a commit graph for a portfolio instead of for code. One
 * cell per day, Sunday to Saturday top to bottom, colour carrying what the
 * holdings actually did that day — never the raw total, which moves on a
 * deposit or a withdrawal whether the market did anything or not. A day
 * with no colour isn't flat, it's one nothing was ever logged for; see
 * brief/display.js's yearGrid for why those are left grey rather than
 * guessed at.
 */
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const LEGEND_BUCKETS = ["r3", "r2", "r1", "flat", "g1", "g2", "g3"];

function YearPage({ d }) {
  const y = d.year;
  if (!y) return null;
  // The week count is real data (weeks vary with what day Jan 1 lands on),
  // so it has to come from JS — but the label column's width is a layout
  // choice, and CSS needs to be free to shrink it on a phone without this
  // component knowing anything about screen size.
  const gridVars = { "--yweeks": y.weeks };

  const cellTitle = (c) => {
    if (c.future) return c.date;
    if (c.dayPct == null) return `${c.date} · no data`;
    const pct = `${c.dayPct > 0 ? "+" : ""}${c.dayPct}%`;
    // Same rounding-to-nearest-dollar the money page's own movers use — a
    // day can have a real dayPct without a dayValue (rows written before
    // money.js started tracking it), so this stays off rather than guessed.
    const dollars = c.dayValue != null ? ` · ${signed(c.dayValue, 0).replace(/^([+-])/, "$1$")} ${y.base}` : "";
    return `${c.date} · ${pct}${dollars}`;
  };

  return (
    <div className="page-year">
      <div className="yhead">
        <div className="ystat">
          <span className="big">Day {y.day}<em>of {y.total}</em></span>
          <span className="sub">{y.pct}% through {y.year}</span>
        </div>
      </div>

      {/* Its own titled section, not just "the grid" — leaves room to stack
          more yearly stat sections between yhead above and this one, as
          they show up, without this section needing to change shape. */}
      <section className="ysection">
        <div className="yshead">
          <h2>Investment Moves</h2>
          <span className="yupdated">
            {y.moneyUpdatedLabel ? <>Last updated <b>{y.moneyUpdatedLabel}</b></> : "Portfolio not pulled yet"}
          </span>
        </div>

        <div className="ycard">
          <div className="ygrid" style={gridVars}>
            {y.months.map((m) => (
              <span className="mlabel" key={`${m.label}-${m.week}`} style={{ gridColumn: m.week + 2, gridRow: 1 }}>
                {m.label}
              </span>
            ))}
            {WEEKDAY_LABELS.map((l, i) => (
              l ? <span className="wlabel" key={i} style={{ gridColumn: 1, gridRow: i + 2 }}>{l}</span> : null
            ))}
            {y.cells.map((c) => (
              <div
                key={c.date}
                className={`ycell b-${c.bucket}${c.today ? " today" : ""}`}
                style={{ gridColumn: c.week + 2, gridRow: c.weekday + 2 }}
                title={cellTitle(c)}
              />
            ))}
          </div>

          <div className="ylegend">
            <span className="ynote">
              Colour is your holdings' actual daily move, not deposits or withdrawals. Grey means no data logged that day.
            </span>
            <span className="yscale">
              Worse
              {LEGEND_BUCKETS.map((b) => <i key={b} className={`yleg b-${b}`} />)}
              Better
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * First cut of a busy-vs-free forecast, on its own page to try out before it
 * earns a spot on Today. Deliberately does NOT try to say "X would fit in
 * that gap" — the backend has no idea how long anything on the looming list
 * actually takes, so the two lists are just laid out side by side and left
 * for a human to weigh against each other.
 */
function WeekPage({ d }) {
  const w = d.week;
  if (!w) return null;

  return (
    <div className="page-week">
      <div className="fchead">
        <span className="big">Next {w.days.length} days</span>
        <span className="sub">
          Busy vs. free out of {w.wakeHours}h of waking hours a day (7am–11pm)
        </span>
      </div>

      <div className="fcgrid">
        {w.days.map((day) => (
          <div className="fcday" key={day.key}>
            <div className="fcdhead">
              <span className="fcdname">{day.label}</span>
              <span className="fcddate">{day.dateLabel}</span>
            </div>
            <div className="fcbar" title={`${day.busyHours}h busy · ${day.freeHours}h free`}>
              <i style={{ width: `${day.load}%` }} />
            </div>
            <span className="fcfree">{day.freeHours}h free</span>
            {day.eventCount > 0 && (
              <span className="fccount">{day.eventCount} on the calendar</span>
            )}
          </div>
        ))}
      </div>

      <section className="zone">
        <h2 className="spaced">Looming</h2>
        {w.looming.length === 0 ? (
          <p className="empty">Nothing due in this window.</p>
        ) : (
          w.looming.map((it) => (
            <div className="trow" key={it.id}>
              <span className="t">{it.in}</span>
              <span className="body">
                <span className="title">{it.title}</span>
                {it.note && <span className="pri">{it.note}</span>}
                <span className="meta">{it.dateLabel}</span>
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/* ================================================================= sources */

function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 36) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/**
 * The pipeline, made visible: every source, when it last actually succeeded,
 * and what it said if it failed — which is how you find out whether the
 * problem is Google, the vault path, or the network, without reading a log
 * file. Read-only. There used to be a per-row "run" button to refresh just
 * one source, but that's a decision nobody actually wants to make — the
 * header refresh button already reruns everything, and that's always what
 * should happen.
 */
function SourcePanel({ onClose, report }) {
  const [rows, setRows] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sources");
      setRows(await r.json());
    } catch { setRows({ sources: [], feeds: [] }); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="panel" onClick={(e) => e.stopPropagation()}>
      <div className="phead">
        <h3>Sources</h3>
        <button className="x" onClick={onClose} title="close">×</button>
      </div>

      {!rows ? (
        <p className="empty">Loading…</p>
      ) : (
        rows.sources.map((s) => {
          const r = report?.[s.name];
          return (
            <div className={`srow${s.lastError ? " bad" : ""}`} key={s.name}>
              <span className="sname">{s.name}</span>
              <span className="sstate">
                {s.lastError ? (
                  <b className="fail">{s.lastError.message}</b>
                ) : (
                  <>
                    {ago(s.lastRun)}
                    {r?.ok && <em className="just">{r.detail || `${r.found} items`} · {r.ms}ms</em>}
                  </>
                )}
              </span>
            </div>
          );
        })
      )}

    </div>
  );
}

/* =================================================================== shell */

const PAGES = { today: TodayPage, tasks: TasksPage, money: MoneyPage, year: YearPage, week: WeekPage };

/**
 * Strip one id out of every list it could be sitting in, immediately and
 * locally — no network round trip. An answered row needs to disappear from
 * "Start here", from its task bucket, and from deadlines all at once, since
 * the same item can be reflected in more than one of those.
 */
function removeItemLocally(d, id) {
  if (!d) return d;
  const drop = (list) => (list || []).filter((it) => it.id !== id);
  const groups = (d.tasks?.groups || [])
    .map((g) => ({ ...g, items: drop(g.items) }))
    .filter((g) => g.items.length > 0);
  return {
    ...d,
    priorities: drop(d.priorities),
    deadlines: drop(d.deadlines),
    tasks: d.tasks
      ? { ...d.tasks, groups, total: groups.reduce((n, g) => n + g.items.length, 0) }
      : d.tasks,
  };
}

export default function Display() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [page, setPage] = useState(0);
  const [healing, setHealing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState(null);
  const [panel, setPanel] = useState(false);
  const lastHeal = useRef(0);
  const lastInput = useRef(0);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/display");
      setD(await res.json());
      setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);

  /**
   * Answering a row. This used to wait on the POST and then a full re-fetch
   * before anything changed on screen — correct, but slow enough that
   * marking something done felt laggy. Now the row is dropped from local
   * state the instant you click, and the network call happens underneath
   * that: on success it quietly reconciles with whatever the server
   * recomputed (a re-ranked "Start here", say); on failure it rolls back to
   * server truth so a real error is never silently swallowed.
   */
  const act = useCallback(async (id, action) => {
    setD((prev) => removeItemLocally(prev, id));
    try {
      const res = await fetch(`/api/items/${encodeURIComponent(id)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const dres = await fetch("/api/display");
      if (dres.ok) setD(await dres.json());
    } catch (e) {
      setErr(e.message);
      reload(); // the optimistic removal was wrong — put things back
    }
  }, [reload]);

  // ------------------------------------------------------------- loading
  useEffect(() => {
    let alive = true;

    /**
     * There is a refresh button now, but the wall-mounted copy has nobody
     * standing in front of it. When the data goes stale this still re-pulls
     * the two cheap sources itself, at most once every half hour.
     */
    const selfHeal = async () => {
      if (Date.now() - lastHeal.current < SELF_HEAL_COOLDOWN) return;
      lastHeal.current = Date.now();
      setHealing(true);
      try {
        await fetch("/api/refresh/calendar", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        await fetch("/api/refresh/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch { /* the footer already says it's stale */ }
      finally { setHealing(false); }
    };

    const load = async () => {
      try {
        const res = await fetch("/api/display");
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        if (!alive) return;
        setD(json);
        setErr(null);
        if (json.freshness?.stale) selfHeal().then(load);
      } catch (e) {
        if (alive) setErr(e.message);
      }
    };

    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setPanel(true);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      setReport(json.report || null);
      if (!res.ok) setErr(json.error || `${res.status}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setRefreshing(false);
      reload();
    }
  }, [refreshing, reload]);

  // ---------------------------------------------------------- navigation
  const count = d?.pages?.length || 4;
  const go = useCallback((n) => { lastInput.current = Date.now(); setPage(((n % count) + count) % count); }, [count]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowRight") go(page + 1);
      else if (e.key === "ArrowLeft") go(page - 1);
      else if (e.key >= "1" && e.key <= String(count)) go(Number(e.key) - 1);
      else if (e.key.toLowerCase() === "r") refresh();
      else if (e.key === "Escape") setPanel(false);
      else return;
      e.preventDefault();
    };
    const onMove = () => { lastInput.current = Date.now(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousemove", onMove); };
  }, [page, count, go, refresh]);

  // Rotate on its own, but never while someone is clearly using it — being
  // yanked to another page mid-read is the fastest way to make a screen
  // feel hostile.
  useEffect(() => {
    const secs = 25;
    const pause = 120 * 1000;
    const t = setInterval(() => {
      if (panel) return;
      if (Date.now() - lastInput.current < pause) return;
      setPage((p) => (p + 1) % count);
    }, secs * 1000);
    return () => clearInterval(t);
  }, [count, panel]);

  // -------------------------------------------------------------- render
  if (err && !d) return <div className="disp"><div className="err">Can't reach the server — {err}</div></div>;
  if (!d) return <div className="disp"><div className="err">Starting…</div></div>;

  if (d.schema !== SCHEMA) {
    return (
      <div className="disp">
        <div className="err">
          This build is out of date ({d.schema || "unknown"} vs {SCHEMA}).<br />
          Run <code>npm run build</code> in /frontend, or use <code>npm run dev</code>.
        </div>
      </div>
    );
  }

  const Page = PAGES[d.pages[page]?.id] || TodayPage;
  const rotating = Date.now() - lastInput.current > 120 * 1000;

  return (
    <div className="disp" onClick={() => setPanel(false)}>
      <header className="top">
        <span className="date">{d.dateLabel}</span>
        <LiveClock timeZone={d.timezone} />
        <nav className="tabs">
          {d.pages.map((p, i) => (
            <button
              key={p.id}
              className={`tab${i === page ? " on" : ""}`}
              onClick={(e) => { e.stopPropagation(); go(i); }}
            >
              {p.label}
              {p.badge ? <i>{p.badge}</i> : null}
            </button>
          ))}
        </nav>
        <span className="right">
          <span className="updated">Last updated <b>{d.lastUpdatedLabel ?? "—"}</b></span>
          <button
            className={`refresh${refreshing ? " spin" : ""}`}
            onClick={(e) => { e.stopPropagation(); lastInput.current = Date.now(); refresh(); }}
            title="Rerun every source now (r)"
          >
            {refreshing ? "running…" : "↻ refresh"}
          </button>
        </span>
      </header>

      <main className="stage">
        <Page d={d} onAct={act} />
      </main>

      <footer className="foot">
        <span className="dots">
          {d.pages.map((p, i) => (
            <button
              key={p.id}
              className={`dot-nav${i === page ? " on" : ""}`}
              onClick={(e) => { e.stopPropagation(); go(i); }}
              title={p.label}
            />
          ))}
          {rotating && <span className="auto">auto</span>}
        </span>
        <button
          className={`status${(d.freshness?.stale || d.freshness?.problem) && !healing ? " stale" : ""}`}
          onClick={(e) => { e.stopPropagation(); lastInput.current = Date.now(); setPanel((v) => !v); }}
          title="Show what each source last did"
        >
          {err
            ? `can't reach the server — ${err}`
            : healing
            ? "checking Google now…"
            : d.freshness?.problem
            ? d.freshness.problem
            : d.freshness?.label ?? "—"}
        </button>
      </footer>

      {panel && <SourcePanel report={report} onClose={() => setPanel(false)} />}
    </div>
  );
}
