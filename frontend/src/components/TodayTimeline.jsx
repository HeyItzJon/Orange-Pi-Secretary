// TodayTimeline.jsx — the day, in order, all of it.
//
// This is the summary band. It deliberately mixes domains, because that IS
// what a day is: you work 12–5 AND there's a barbecue at 7. Separating those
// into different lists would hide the shape of the day.
//
// The domain tag on the right does the labelling work, so "work" and "social"
// read as different kinds of thing without being pulled apart. The lanes
// below handle focus; this handles orientation.

function timeOf(item, timeZone) {
  if (item.meta?.allDay || !item.dueAt) return "all day";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  })
    .format(new Date(item.dueAt))
    .replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`);
}

export default function TodayTimeline({ items, timezone, domainLabels }) {
  if (!items?.length) {
    return (
      <section className="section today">
        <h2>Today</h2>
        <div className="note">Nothing scheduled.</div>
      </section>
    );
  }

  return (
    <section className="section today">
      <h2>
        Today
        <span className="count">— {items.length}</span>
      </h2>

      {items.map((item) => (
        <div className="trow" key={item.id} title={item._rankWhy?.join(", ")}>
          <div className="ttime">{timeOf(item, timezone)}</div>
          <div className="tbody">
            <div className="ttitle">
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
              ) : (
                item.title
              )}
            </div>
            {item.detail && <div className="tdetail">{item.detail}</div>}
          </div>
          <div className={`tdomain d-${item.domain || "personal"}`}>
            {domainLabels?.[item.domain] || item.domain || "Personal"}
          </div>
        </div>
      ))}
    </section>
  );
}
