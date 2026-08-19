// BriefItem.jsx — one line of the brief.
//
// Three layers, and none of them repeats another:
//   left    when it is
//   title   what it is  (+ urgency, which is a bordered chip carrying a WORD,
//           never colour alone, so it survives colourblindness and greyscale)
//   meta    what kind of thing it is, then facts the title doesn't carry
//
// Hovering a row shows why it ranked where it did.

const URGENCY_WORD = {
  critical: "NOW",
  serious: "SOON",
  warning: "THIS WEEK",
};

function dueLabel(item) {
  const d = item._daysUntil;
  if (d === null || d === undefined) return null;
  if (d < 0) return `${Math.abs(d)}d overdue`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

function whenColumn(item, timeZone) {
  if (item.source === "note") return `${item.meta?.age ?? ""}d`;
  if (!item.dueAt) return "";
  const date = new Date(item.dueAt);
  const d = item._daysUntil;

  if (item.kind === "today") {
    if (item.meta?.allDay) return "all day";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(date).replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);
  }
  if (d !== null && d >= 0 && d <= 6) {
    return new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric" }).format(date);
}

export default function BriefItem({ item, timezone, onAction, busy }) {
  const isToday = item.kind === "today";

  // Today's rows already carry their time in the left column; an urgency chip
  // on top would appear on literally everything happening today.
  const urgencyWord = isToday ? null : URGENCY_WORD[item._urgency];
  const due = dueLabel(item);

  // "told you 3×" is the point of the memory model — but only for things that
  // persist. Saying it about today's lecture is noise.
  const facts = [
    item.detail,
    !isToday && item.surfaceCount > 2 ? `told you ${item.surfaceCount}×` : null,
    !isToday && due ? due : null,
  ].filter(Boolean);

  const receipt = item._rankWhy?.length
    ? `Ranked ${item._rank} — ${item._rankWhy.join(", ")}`
    : undefined;

  return (
    <div className={`item${busy ? " busy" : ""}`} title={receipt}>
      <div className="when">{whenColumn(item, timezone)}</div>

      <div className="body">
        <div className="title">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
          ) : (
            item.title
          )}

          {urgencyWord && (
            <span className={`chip ${item._urgency}`}>
              <span className="dot" aria-hidden="true">▲</span>{urgencyWord}
            </span>
          )}
          {item._changed && (
            <span className="chip neutral"><span className="dot" aria-hidden="true">+</span>CHANGED</span>
          )}
          {item._new && !item._changed && (
            <span className="chip neutral"><span className="dot" aria-hidden="true">+</span>NEW</span>
          )}
        </div>

        <div className="meta">
          {item.categoryLabel && <span className="tag">{item.categoryLabel}</span>}
          {facts.map((f, i) => (
            <span key={i} className={i === 0 ? "lead" : undefined}>
              {i === 0 && !item.categoryLabel ? "" : " · "}{f}
            </span>
          ))}
          {/* Only worth saying when we couldn't show the note itself —
              otherwise the note IS the prep, and this would just repeat it. */}
          {item.meta?.needsPrep && isToday && !item.detail && (
            <span className="tag prep">needs prep</span>
          )}
        </div>
      </div>

      {!isToday && (
        <div className="actions">
          <button onClick={() => onAction(item.id, "done")} title="Done — never show again">Done</button>
          <button onClick={() => onAction(item.id, "snooze")} title="Hide for 3 days">Later</button>
        </div>
      )}
    </div>
  );
}
