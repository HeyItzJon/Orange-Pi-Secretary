// Legend.jsx — what everything on this screen means.
//
// Collapsed by default. It exists because a dashboard full of tags and chips
// you have to remember the meaning of is worse than one with fewer features.

import { useState } from "react";

const SOURCES = [
  ["Gmail", "Only mail that matches your rules — a named person, your work domain, or a keyword. Everything else never appears."],
  ["Google Calendar", "The calendars listed in config. Today's go to the timeline; later ones go to their lane."],
  ["Finance", "Your holdings. Speaks only when a rule fires — a big move, drift past your band, or a contribution date. Share counts and book value come from your vault's holding notes, but nothing else in the vault is read."],
];

const CHIPS = [
  ["NOW", "critical", "Due today, tomorrow, or already overdue"],
  ["SOON", "serious", "Due within 3 days"],
  ["THIS WEEK", "warning", "Due within 7 days"],
  ["+ NEW", "neutral", "First time it has appeared in a brief"],
  ["+ CHANGED", "neutral", "It existed before, but the time or details moved"],
];

export default function Legend() {
  const [open, setOpen] = useState(false);

  return (
    <section className="legend">
      <button className="legend-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} What do these mean?
      </button>

      {open && (
        <div className="legend-body">
          <h3>Where things come from</h3>
          <dl>
            {SOURCES.map(([name, what]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>

          <h3>The lanes</h3>
          <p>
            <b>Today</b> is your whole day in order, every part of life mixed together, because
            that's what a day is. Everything else is grouped by area — School, Work, Career,
            Finance, Social, Projects, Personal — so you can look at one thing at a time.
          </p>

          <h3>Tags and chips</h3>
          <p>
            The grey <span className="tag">TAG</span> says what <i>kind</i> of thing it is —
            Class, Test, Shift, Appointment. The coloured chips say how urgent it is:
          </p>
          <ul className="legend-chips">
            {CHIPS.map(([label, cls, what]) => (
              <li key={label}>
                <span className={`chip ${cls}`}>
                  {cls !== "neutral" && <span className="dot" aria-hidden="true">▲</span>}
                  {label.replace("+ ", "")}
                </span>
                <span>{what}</span>
              </li>
            ))}
          </ul>

          <h3>Quieter items</h3>
          <p>
            Nothing is ever hidden from you. If the system has told you about something several
            times, it hasn't changed, and it has no deadline, it gets folded behind a
            <b> "N quieter"</b> line at the bottom of its lane. Click to open it. Anything with a
            deadline — or written in CAPS — is never folded away.
          </p>

          <h3>Done / Later</h3>
          <p>
            Hover any row. <b>Done</b> means never show me this again. <b>Later</b> hides it for
            three days. Both are how you teach it to stop repeating itself.
          </p>
        </div>
      )}
    </section>
  );
}
