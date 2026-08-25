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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./Display.css";

const SCHEMA = "display-v2";
const POLL_MS = 60 * 1000;              // cheap: recomputed from the local store
const SELF_HEAL_COOLDOWN = 30 * 60 * 1000;

const money = (n) => `$${Math.round(n).toLocaleString("en-CA")}`;
const signed = (n, dp = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}`;

// Every calendar block used to get two colours from one fixed CSS palette —
// a dark-ish background, white text, and a lightened left-edge accent —
// because the whole category palette was deliberately kept mid-dark (see the
// comment on .blk.d-* in Display.css). Real per-calendar colours from Google
// run the full range, right down to pale custom pastels, where white text
// and a lightened accent both stop being readable. blockStyle() checks one
// brightness threshold and picks text/accent/overlap-marker colour to hold
// contrast whichever way the real colour goes; null when there's no real
// colour on record, so the .d-{swatch} CSS class stays in charge instead.
function hexRGB(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const brightness = ([r, g, b]) => (r * 299 + g * 587 + b * 114) / 1000;
const mixToward = (rgb, target, amt) => rgb.map((v) => Math.round(v + (target - v) * amt));
const rgbStr = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

function blockStyle(hex) {
  const rgb = hexRGB(hex);
  if (!rgb) return null;
  const light = brightness(rgb) >= 150;
  return {
    background: rgbStr(rgb),
    borderLeftColor: rgbStr(mixToward(rgb, light ? 0 : 255, light ? 0.35 : 0.45)),
    color: light ? "#0a0a0a" : "#ffffff",
    "--stripe": light ? "rgba(10,10,10,.4)" : "rgba(255,255,255,.6)",
  };
}

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

/**
 * The date, split for two-tier sizing: the weekday reads biggest, the
 * month/day underneath it a size down — same "Tuesday" / "August 25" split
 * Jon asked for. `dateLabel` always comes from the backend as one
 * comma-joined string (fmt(now, tz, { weekday: "long", month: "long", day:
 * "numeric" }) in brief/display.js) — this just re-splits it rather than
 * building a second date string client-side, so the two can never drift.
 */
function splitDateLabel(label) {
  const i = String(label || "").indexOf(",");
  if (i === -1) return [label || "", ""];
  return [label.slice(0, i), label.slice(i + 1).trim()];
}

/**
 * The big, prominent header Jon asked for: today's date, large, with a
 * clock face that actually rotates — the one clock on the page meant to be
 * watched rather than read once and forgotten. Always shows the REAL
 * current time regardless of which day's timeline the carousel below is
 * showing (see DayCarousel) — it's a wall clock, not a preview of a future
 * day, which doesn't have a "now" to show.
 */
function TodayHeader({ dateLabel, timeZone }) {
  const [weekday, monthDay] = splitDateLabel(dateLabel);
  return (
    <div className="tday-head">
      <div className="tday-date">
        <span className="tday-weekday">{weekday}</span>
        <span className="tday-monthday">{monthDay}</span>
      </div>
      <AnalogClock timeZone={timeZone} />
    </div>
  );
}

/** A genuine rotating analog clock — hour/minute/second hands, ticking every
 *  second — plus a small digital readout underneath for anyone who'd rather
 *  just read it. Always real, local time; see TodayHeader above. */
function AnalogClock({ timeZone }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const h = Number(parts.hour) % 12;
  const m = Number(parts.minute);
  const s = Number(parts.second);
  const hourDeg = h * 30 + m * 0.5;
  const minDeg = m * 6 + s * 0.1;
  const secDeg = s * 6;

  return (
    <div className="aclock" title={liveClockLabel(now, timeZone)}>
      <div className="aclock-face">
        {Array.from({ length: 12 }).map((_, i) => (
          <span key={i} className={`aclock-tick${i % 3 === 0 ? " major" : ""}`} style={{ transform: `rotate(${i * 30}deg)` }} />
        ))}
        <div className="aclock-hand hour" style={{ transform: `rotate(${hourDeg}deg)` }} />
        <div className="aclock-hand min" style={{ transform: `rotate(${minDeg}deg)` }} />
        <div className="aclock-hand sec" style={{ transform: `rotate(${secDeg}deg)` }} />
        <div className="aclock-hub" />
      </div>
      {/* The digital readout used to sit here as its own line — Jon asked
          for it gone; the exact time is still one hover away via this
          div's own title attribute above, so nothing is actually lost. */}
    </div>
  );
}

/**
 * The forward-only day pager Jon asked for: the same day-strip graphic
 * (all-day chips + hour blocks), one page per day, sliding sideways between
 * Today and the next 3 days (see `dayStrips` in brief/display.js). No back
 * beyond today — there's nothing behind it to preview — and no progress
 * marker on a future day, since nothing on it has happened yet.
 *
 * `slides[0]` is always today (built from `d.strip`, which is the only one
 * carrying `nowPct`); `slides[1..]` come straight from `d.dayStrips`. Only
 * one slide is ever mounted at a time — swapping the single Strip instance
 * and re-triggering a directional CSS animation keyed by the offset, rather
 * than mounting all four — so Strip's own hover/tap card state never has to
 * be reasoned about across four instances at once.
 */
function DayCarousel({ slides, offset, onOffset }) {
  const max = slides.length - 1;
  const touchX = useRef(null);
  // `dir` (which way to animate) has to be derived, not stored: this is now
  // a controlled component (offset lives in Display(), so WeekPage's day-card
  // clicks can set it before TodayPage even mounts) — comparing against the
  // previous render's offset via a ref gives the same "which way did we just
  // move" signal a local setDir(...) used to, without a second piece of
  // state that could drift out of sync with the offset prop.
  const prevOffset = useRef(offset);
  const dir = offset > prevOffset.current ? 1 : offset < prevOffset.current ? -1 : 1;
  useEffect(() => { prevOffset.current = offset; }, [offset]);

  const goTo = (n) => {
    const clamped = Math.max(0, Math.min(max, n));
    if (clamped === offset) return;
    onOffset(clamped);
  };

  const onTouchStart = (e) => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touchX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) < 40) return; // a tap or a scroll, not a swipe
    goTo(dx < 0 ? offset + 1 : offset - 1);
  };

  const slide = slides[offset];

  return (
    <div className="daycar">
      <div className="daycar-head">
        <button className="daycar-arrow" disabled={offset === 0} onClick={() => goTo(offset - 1)} aria-label="Previous day">‹</button>
        <span className="daycar-label">
          <span className="daycar-name">{slide.label}</span>
          <span className="daycar-date">{slide.dateLabel}</span>
        </span>
        <button className="daycar-arrow" disabled={offset === max} onClick={() => goTo(offset + 1)} aria-label="Next day">›</button>
      </div>
      <div className="daycar-viewport" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div key={offset} className={`daycar-slide${dir > 0 ? " fwd" : " back"}`}>
          <Strip strip={slide} />
        </div>
      </div>
      {slides.length > 1 && (
        <div className="daycar-dots">
          {slides.map((s, i) => (
            <button
              key={s.key || i}
              className={`daycar-dot${i === offset ? " on" : ""}`}
              onClick={() => goTo(i)}
              title={s.label}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * All-day events never become blocks on the hour-by-hour strip below (there's
 * no time to plot them at) — this is where they actually show, as a row of
 * small chips sitting above it. Same real calendar colour as a timed block
 * when there's one on record (blockStyle, same as Strip's blocks use), the
 * .d-{swatch} palette as the fallback underneath. Order comes pre-sorted
 * from the backend (see sortAllDay in brief/display.js) — can't-miss first,
 * then flagged, then alphabetical — so nothing here has to re-decide it.
 */
function AllDayRow({ items }) {
  // Always renders the row itself — even with nothing in it — so its
  // reserved height (see .aday-row's min-height in Display.css) holds the
  // timeline strip below in the same place on every carousel slide. Letting
  // this return null on an empty day (the old behaviour) meant paging from
  // a day with an all-day chip to one without visibly yanked the strip up,
  // and back down again paging the other way.
  const has = items && items.length > 0;
  return (
    <div className="aday-row">
      {has && (
        <>
          <span className="aday-label">All day</span>
          <div className="aday-chips">
            {items.map((c) => (
              <span
                key={c.id}
                className={`aday-chip d-${c.swatch}`}
                style={blockStyle(c.color) || {}}
                title={[c.title, c.priority].filter(Boolean).join(" — ")}
              >
                {c.title}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Strip({ strip }) {
  // Which block's card is pinned open by a tap — mouse hover does this too,
  // but a touch screen has no hover, so a tap toggles the same card via this
  // instead. A document-level listener closes it on the next tap anywhere
  // else; each block's own handler stops that tap from immediately
  // re-closing what it just opened.
  const [openId, setOpenId] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  // Every block's own DOM node, keyed by id — the card is rendered through a
  // portal (see below), so positioning it means asking the block directly
  // where it actually is on screen rather than relying on CSS layout.
  const blockRefs = useRef(new Map());
  const cardRef = useRef(null);
  const [cardPos, setCardPos] = useState(null);

  const activeId = openId ?? hoverId;

  useEffect(() => {
    if (openId == null) return;
    const close = () => setOpenId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openId]);

  // The card used to live *inside* the block (position: absolute, anchored
  // to it) — which reads fine until you notice .blk, .strip and .stage all
  // clip their own overflow to keep the timeline's rounded corners and
  // scroll region honest. A child can't escape an ancestor's overflow:hidden
  // no matter what position scheme it uses, so the card was being silently
  // clipped away every time, on both hover and tap. A React portal renders
  // it into document.body instead — still driven by this component's state,
  // but no longer a DOM descendant of anything that clips it — positioned
  // with real viewport coordinates taken from the block's own
  // getBoundingClientRect() plus the card's own measured size, so it always
  // ends up fully on-screen regardless of where its block sits.
  useLayoutEffect(() => {
    if (activeId == null) { setCardPos(null); return; }
    const anchor = blockRefs.current.get(activeId);
    const card = cardRef.current;
    if (!anchor || !card) { setCardPos(null); return; }
    const ar = anchor.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const GAP = 9;
    const PAD = 8;

    let left = ar.left;
    if (left + cw > window.innerWidth - PAD) left = Math.max(PAD, window.innerWidth - PAD - cw);
    left = Math.max(PAD, left);

    // Open upward by default (same as before), but flip to open downward
    // when there isn't enough room above the block.
    let top = ar.top - GAP - ch;
    if (top < PAD) top = ar.bottom + GAP;
    top = Math.min(top, window.innerHeight - PAD - ch);

    setCardPos({ top, left });
  }, [activeId, strip]);

  // Orientation changes / resizes can leave a stale position behind — closing
  // is simpler and safer than trying to re-derive it mid-gesture.
  useEffect(() => {
    if (activeId == null) return;
    const closeAll = () => { setOpenId(null); setHoverId(null); };
    window.addEventListener("resize", closeAll);
    return () => window.removeEventListener("resize", closeAll);
  }, [activeId]);

  if (!strip) return null;

  const activeBlock = activeId != null ? strip.blocks.find((b) => b.id === activeId) : null;

  return (
    <>
      {/* A sibling of .strip-wrap, deliberately NOT a child of it: .nowline
          inside .strip-wrap is absolutely positioned against .strip-wrap's
          own top edge (see the comment on .nowline in Display.css), and
          AllDayRow only renders on days that actually have one — folding it
          inside .strip-wrap would shift that top edge (and therefore the
          now-marker) up or down depending on whether today happens to have
          an all-day event, which is exactly the kind of thing that should
          never move. Sitting outside keeps .strip-wrap's own coordinate
          space exactly what it was before this existed. */}
      <AllDayRow items={strip.allDay} />
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
              ref={(el) => {
                if (el) blockRefs.current.set(b.id, el);
                else blockRefs.current.delete(b.id);
              }}
              className={`blk d-${b.swatch}${b.important ? " imp" : ""}${b.past ? " past" : ""}${openId === b.id ? " open" : ""}${b.overlap ? " overlap" : ""}`}
              style={{
                left: `${b.left}%`,
                width: `${b.width}%`,
                // The real Google calendar colour, when this item has one —
                // overrides the .d-{swatch} class's fixed palette entirely,
                // text colour included (see blockStyle above). The class
                // stays in the className above as the fallback for an item
                // with no colour on record.
                ...(blockStyle(b.color) || {}),
              }}
              onMouseEnter={() => setHoverId(b.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === b.id ? null : cur))}
              onClick={(e) => {
                e.stopPropagation();
                setOpenId((cur) => (cur === b.id ? null : b.id));
              }}
            >
              {b.label && (
                <span className="bl">
                  {b.label}
                  {b.time && <em>{b.time}</em>}
                </span>
              )}
            </div>
          ))}
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
        {/* A sibling of .strip, not a child of it — .strip clips its own
            overflow to keep blocks contained (see the metadata-card comment
            above), and this is deliberately drawn taller than the strip
            itself, so it has to live outside that clip to actually show the
            part that pokes out. Same left% as everything above: .strip-wrap
            is exactly as wide as .strip.

            Only Today's own strip carries nowPct (see buildDayStrip in
            brief/display.js) — a future day in the carousel has no "now" to
            mark, and rendering this with a missing/undefined left would
            fall back to the browser's own default position (effectively
            the left edge) rather than just not showing, which is what
            actually happened before this check existed. */}
        {strip.nowPct != null && <div className="nowline" style={{ left: `${strip.nowPct}%` }} />}

        {/* A twenty-minute gap is two pixels wide. Hover — or a tap, on a
            touch screen, see openId/hoverId above — is how it gets to say what
            it is without stealing width from the events that fit their own
            label. Portaled to document.body (see the useLayoutEffect above) so
            the timeline's own overflow:hidden never clips it. */}
        {activeBlock?.detail && createPortal(
          <div
            ref={cardRef}
            className="strip-card"
            style={cardPos ? { top: cardPos.top, left: cardPos.left } : { top: -9999, left: -9999, visibility: "hidden" }}
          >
            <b>{activeBlock.detail.title}</b>
            <span className="crange">
              {activeBlock.detail.range}
              {activeBlock.detail.duration && <> · {activeBlock.detail.duration}</>}
            </span>
            {activeBlock.detail.where && <span className="cwhere">{activeBlock.detail.where}</span>}
            {activeBlock.detail.prep && <span className="cprep">{activeBlock.detail.prep}</span>}
            {activeBlock.detail.priority && <span className="cpri">{activeBlock.detail.priority}</span>}
            {/* The overlap flag itself (see brief/display.js) said in words,
                not just the corner mark on the block — a sliver too narrow
                for that mark to read as anything still has this. */}
            {activeBlock.overlap && <span className="cflag">Overlaps another event</span>}
          </div>,
          document.body
        )}
      </div>
    </>
  );
}

/* =================================================================== pages */

function TodayPage({ d, dayOffset, onDayOffset }) {
  // Today's own strip already carries everything DayCarousel needs
  // (blocks/chunks/ticks/allDay, plus nowPct — the one field that marks it
  // as "today" rather than a future day); dayStrips (see brief/display.js)
  // supplies the next 3 days in the exact same shape, minus that marker.
  const slides = [
    { key: "today", label: "Today", dateLabel: d.dateLabel, ...d.strip },
    ...(d.dayStrips || []),
  ];
  // dayOffset lives up in Display() (not local state here) so a WeekPage
  // click on "Thursday" can land this page already turned to Thursday's
  // slide, and so switching tabs away and back doesn't reset the carousel
  // to Today every time TodayPage remounts. Clamp defensively in case a
  // stale offset (e.g. from a previous, longer dayStrips array) arrives.
  const offset = Math.max(0, Math.min(slides.length - 1, dayOffset ?? 0));
  const onToday = offset === 0;
  const slide = slides[offset];

  return (
    <>
      <TodayHeader dateLabel={d.dateLabel} timeZone={d.timezone} />

      {onToday ? (
        <div className={`hero${d.hero.urgent ? "" : " calm"}`}>
          <span className="lbl">{d.hero.urgent ? "NOW" : "NEXT"}</span>
          <span className="big">{d.hero.lead}</span>
          {d.hero.sub && <span className="sub">{d.hero.sub}</span>}
        </div>
      ) : (
        // Paged off Today: there's no "NOW"/"NEXT" to show for a day that
        // hasn't happened yet, so this swaps in a plain-language summary of
        // that day instead (see daySummary() in brief/display.js) — reusing
        // the same calm hero styling rather than introducing a new block.
        <div className="hero calm">
          <span className="lbl">{slide.label.toUpperCase()}</span>
          <span className="big">{slide.summary}</span>
        </div>
      )}

      <DayCarousel slides={slides} offset={offset} onOffset={onDayOffset} />

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
          {/* Scrollable on its own — see .ygrid-scroll in the phone media
              query. On a wide screen the grid already shrinks to fit (each
              cell is a 1fr column), so this never needs to scroll there; on
              a phone the grid instead renders at a fixed, legible cell size
              and this is what makes the columns past the first screenful
              reachable, rather than silently clipped by an ancestor's
              overflow:hidden — the wall-display layout this page was
              originally built for was never meant to be scrolled, but a
              365-day grid on a phone has no other way to all fit. */}
          <div className="ygrid-scroll">
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
function WeekPage({ d, onGoToDay }) {
  const w = d.week;
  const [farNotice, setFarNotice] = useState(false);
  const farTimer = useRef(null);

  useEffect(() => () => { if (farTimer.current) clearTimeout(farTimer.current); }, []);

  if (!w) return null;

  // Only the first 4 days here (today + the next 3) have a matching Today
  // carousel slide (see dayStrips in brief/display.js, which only ever
  // looks 3 days ahead) — so only those are actually clickable. The rest of
  // the week's days exist on this forecast but have no Today-page view to
  // send you to yet.
  const clickableCount = 4;

  const onCardClick = (i) => {
    if (!onGoToDay) return;
    if (i < clickableCount) {
      onGoToDay(i);
    } else {
      if (farTimer.current) clearTimeout(farTimer.current);
      setFarNotice(true);
      farTimer.current = setTimeout(() => setFarNotice(false), 1800);
    }
  };

  return (
    <div className="page-week">
      <div className="fchead">
        <span className="big">Next {w.days.length} days</span>
        <span className="sub">
          Busy vs. free out of {w.wakeHours}h of waking hours a day (7am–11pm)
        </span>
      </div>

      {farNotice && <div className="fcfar">Too far out to see a view — pick one of the next 3 days.</div>}

      <div className="fcgrid">
        {w.days.map((day, i) => (
          <div
            className={`fcday${i < clickableCount ? " clickable" : ""}`}
            key={day.key}
            onClick={() => onCardClick(i)}
            role={onGoToDay ? "button" : undefined}
            tabIndex={onGoToDay ? 0 : undefined}
          >
            <div className="fcdhead">
              <span className="fcdnamewrap">
                <span className="fcdname">{day.label}</span>
                <span className="fcddate">{day.dateLabel}</span>
              </span>
              {/* A day with nothing timed on it can still carry a deadline —
                  the busy/free bar below has no way to say that (see
                  weekForecast's own comment on why it doesn't guess a
                  duration for these), so this badge is what actually flags
                  it. Hover/tap for which — see title below. */}
              {day.allDay?.length > 0 && (
                <span className="fcallday" title={day.allDay.map((a) => a.title).join(", ")}>
                  {day.allDay.length}
                </span>
              )}
            </div>
            {/* Coloured by calendar swatch, same family the day strip itself
                uses — roughly sized and positioned, nothing to hover, no
                label of its own. Whatever's left grey (the bar's own
                background) is free time; that's the whole point of it. */}
            <div className="fcbar" title={`${day.busyHours}h busy · ${day.freeHours}h free`}>
              {(day.segments || []).map((s, i) => (
                <i
                  key={i}
                  className={`d-${s.swatch}`}
                  style={{
                    left: `${s.left}%`,
                    width: `${s.width}%`,
                    ...(s.color ? { background: s.color } : {}),
                  }}
                />
              ))}
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
 *
 * Two independent ways in: a click on the footer's status line pins it open
 * (closed again by another click anywhere, the × button, or Escape), and
 * hovering "Last updated" in the header shows it as a glance-and-go tooltip
 * — see hoverPanel in Display() below. onMouseEnter/onMouseLeave here keep
 * it open while the cursor crosses from the header text onto the panel
 * itself, so reading it doesn't require holding perfectly still.
 */
function SourcePanel({ onClose, report, refreshing, onMouseEnter, onMouseLeave }) {
  const [rows, setRows] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sources");
      setRows(await r.json());
    } catch { setRows({ sources: [], feeds: [] }); }
  }, []);

  // The header's refresh button opens this panel the instant it's clicked
  // (see refresh() below), before the actual refresh has run — so a fetch
  // on mount alone was capturing each source's lastRun from BEFORE the
  // refresh, and nothing here ever asked again once it finished, which is
  // why every row kept reading "3m ago" instead of "just now" even after
  // the refresh completed. Re-fetching whenever `refreshing` flips back to
  // false (the refresh just finished) fixes that, on top of the existing
  // fetch on mount for when this panel is opened on its own, refresh idle.
  useEffect(() => { load(); }, [load, refreshing]);

  return (
    <div
      className="panel"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
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
  // Separate from `panel`: that one is a click-to-pin toggle (footer status
  // line, or auto-opened by refresh — see refresh() below), closed by
  // another click, ×, or Escape. This one is a plain hover-to-peek on "Last
  // updated" in the header, gone the moment the cursor leaves it (or the
  // panel it's showing) — no click needed either way. The panel renders
  // whenever either is true, so a pinned-open panel never disappears just
  // because a hover elsewhere happened to end.
  const [hoverPanel, setHoverPanel] = useState(false);
  // Which day the Today page's carousel is turned to — lifted up here
  // (rather than living inside TodayPage) for two reasons: TodayPage itself
  // unmounts every time you switch tabs (Today/Week/Tasks/...), which would
  // reset a local offset back to 0 every time you came back; and WeekPage's
  // day-card clicks (see goToDay below) need to set it before/while
  // switching the top-level page to Today.
  const [dayOffset, setDayOffset] = useState(0);
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

  // Used by WeekPage's day-card clicks: turn the Today carousel to the given
  // day, then switch the top-level view to the Today tab. Falls back to
  // whatever page 0 is if this build has no "today" page for some reason.
  const goToDay = useCallback((n) => {
    setDayOffset(n);
    const idx = d?.pages?.findIndex((p) => p.id === "today");
    go(idx != null && idx >= 0 ? idx : 0);
  }, [d, go]);

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
          <span
            className="updated"
            onMouseEnter={() => setHoverPanel(true)}
            onMouseLeave={() => setHoverPanel(false)}
            title="Hover for what each source last did"
          >
            Last updated <b>{d.lastUpdatedLabel ?? "—"}</b>
          </span>
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
        <Page d={d} onAct={act} dayOffset={dayOffset} onDayOffset={setDayOffset} onGoToDay={goToDay} />
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

      {(panel || hoverPanel) && (
        <SourcePanel
          report={report}
          refreshing={refreshing}
          onClose={() => { setPanel(false); setHoverPanel(false); }}
          onMouseEnter={() => setHoverPanel(true)}
          onMouseLeave={() => setHoverPanel(false)}
        />
      )}
    </div>
  );
}
