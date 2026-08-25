// Lane.jsx — one area of your life.
//
// Shows EVERYTHING in the lane. There is no cap and nothing is dropped.
//
// Items you've been told about repeatedly, that haven't changed and have no
// deadline, are marked "quiet" and collapsed behind a toggle — but the toggle
// always states how many there are, so you can see at a glance that they
// exist. The previous version silently truncated each lane at six, which is
// how ten work items vanished without a trace.

import { useState } from "react";
import BriefItem from "./BriefItem.jsx";

function MoneyLine({ money, hasItems }) {
  if (!money) return null;
  const pct = money.dayPct ?? 0;
  return (
    <div className="money-line">
      <span className="money-val">${Math.round(money.total).toLocaleString("en-CA")}</span>
      <span className={pct >= 0 ? "up" : "down"}>
        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}% today
      </span>
      <span className="quiet">
        {money.holdingCount} holdings{!hasItems && " — nothing needs you"}
      </span>
    </div>
  );
}

export default function Lane({
  id, label, items = [], money = null, timezone, onAction, busyIds, filtered, source,
}) {
  const [showQuiet, setShowQuiet] = useState(false);

  const loud = items.filter((i) => !i._quiet);
  const quiet = items.filter((i) => i._quiet);
  const showMoney = id === "finance" && money && (!filtered || items.length > 0);

  if (!items.length && !showMoney) return null;

  return (
    <section className={`section lane lane-${id}`}>
      <h2>
        <span className={`ldot d-${id}`} aria-hidden="true" />
        {label}
        {items.length > 0 && <span className="count">— {items.length}</span>}
        {source && <span className="lsource">{source}</span>}
      </h2>

      {showMoney && <MoneyLine money={money} hasItems={items.length > 0} />}

      {loud.map((item) => (
        <BriefItem
          key={item.id}
          item={item}
          timezone={timezone}
          onAction={onAction}
          busy={busyIds.has(item.id)}
        />
      ))}

      {quiet.length > 0 && (
        <>
          <button className="quiet-toggle" onClick={() => setShowQuiet(!showQuiet)}>
            {showQuiet ? "▾" : "▸"} {quiet.length} quieter{" "}
            <span className="quiet-why">
              — told you about {quiet.length === 1 ? "this" : "these"} several times, no deadline
            </span>
          </button>
          {showQuiet &&
            quiet.map((item) => (
              <BriefItem
                key={item.id}
                item={item}
                timezone={timezone}
                onAction={onAction}
                busy={busyIds.has(item.id)}
              />
            ))}
        </>
      )}

      {!items.length && filtered && <div className="note">Nothing here matches that filter.</div>}
    </section>
  );
}
