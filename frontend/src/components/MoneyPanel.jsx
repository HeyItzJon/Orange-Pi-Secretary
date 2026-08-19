// MoneyPanel.jsx
//
// One line most days. The headline number plus the day's move, then whatever
// rules fired — usually nothing, in which case it says so and stops.
//
// Nothing here is advice: it reports what moved and what drifted.

import BriefItem from "./BriefItem.jsx";

export default function MoneyPanel({ money, items, timezone, onAction, busyIds }) {
  if (!money && (!items || items.length === 0)) return null;

  const pct = money?.dayPct ?? 0;
  const dir = pct >= 0 ? "up" : "down";

  return (
    <section className="section">
      <h2>Money</h2>

      {money && (
        <div className="money-line">
          <span className="money-val">
            ${Math.round(money.total).toLocaleString("en-CA")}
          </span>
          <span className={dir}>
            {pct >= 0 ? "+" : ""}{pct.toFixed(2)}% today
          </span>
          {(!items || items.length === 0) && (
            <span className="quiet">— nothing needs you</span>
          )}
        </div>
      )}

      {items?.map((item) => (
        <BriefItem
          key={item.id}
          item={item}
          timezone={timezone}
          onAction={onAction}
          busy={busyIds.has(item.id)}
        />
      ))}

      {money && (money.stale > 0 || money.unavailable > 0) && (
        <div className="note">
          {money.unavailable > 0 && `${money.unavailable} holding(s) have no price. `}
          {money.stale > 0 && `${money.stale} showing a cached price.`}
        </div>
      )}
    </section>
  );
}
