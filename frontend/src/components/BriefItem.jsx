// BriefItem.jsx — one line of the brief.
//
// Urgency is shown as a bordered chip carrying a WORD, never colour alone —
// so it survives colourblindness, greyscale printing and a glance from across
// a desk.

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
  return `${d} days`;
}

function whenColumn(item, timezone) {
  if (item.source === "note") return `${item.meta?.age ?? ""}d`;
  if (!item.dueAt) return "";
  const date = new Date(item.dueAt);
  const d = item._daysUntil;

  if (item.kind === "today" && !item.meta?.allDay) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(date).replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);
  }
  if (item.kind === "today") return "all day";
  if (d !== null && d <= 6 && d >= 0) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, month: "short", day: "numeric" }).format(date);
}

export default function BriefItem({ item, timezone, onAction, busy }) {
  // Today's events already carry their time in the left column; an urgency
  // chip on top of that is noise, and everything today would wear one.
  const urgencyWord = item.kind === "today" ? null : URGENCY_WORD[item._urgency];
  const due = dueLabel(item);

  // "told you 3×" is the point of the memory model — but only for things
  // that persist. Saying it about today's lecture is just noise.
  const isToday = item.kind === "today";
  const metaBits = [
    item.detail,
    !isToday && item.surfaceCount > 2 ? `told you ${item.surfaceCount}×` : null,
    !isToday && due ? due : null,
  ].filter(Boolean);

  return (
    <div className={`item${busy ? " busy" : ""}`}>
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
          {item.meta?.needsPrep && item.kind === "today" && (
            <span className="chip warning"><span className="dot" aria-hidden="true">◆</span>PREP</span>
          )}
        </div>

        {metaBits.length > 0 && (
          <div className="meta">
            <span className="src">{metaBits[0]}</span>
            {metaBits.slice(1).map((b, i) => <span key={i}> · {b}</span>)}
          </div>
        )}
      </div>

      {item.kind !== "today" && (
        <div className="actions">
          <button onClick={() => onAction(item.id, "done")} title="Done — never show again">Done</button>
          <button onClick={() => onAction(item.id, "snooze")} title="Hide for 3 days">Later</button>
        </div>
      )}
    </div>
  );
}
