// Section.jsx — a titled block of the brief.
//
// Renders nothing at all when empty. That is the single most important
// behaviour in this UI: a short brief is the system working, not failing.

import BriefItem from "./BriefItem.jsx";

export default function Section({ title, items, timezone, onAction, busyIds, showCount = true }) {
  if (!items || items.length === 0) return null;

  return (
    <section className="section">
      <h2>
        {title}
        {showCount && items.length > 1 && <span className="count">— {items.length}</span>}
      </h2>
      {items.map((item) => (
        <BriefItem
          key={item.id}
          item={item}
          timezone={timezone}
          onAction={onAction}
          busy={busyIds.has(item.id)}
        />
      ))}
    </section>
  );
}
