export default function Header({ pages, activePage, onChangePage, generatedAt, loading, cacheStatus }) {
  const timeLabel = generatedAt
    ? new Date(generatedAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })
    : "not yet run";

  const statusDisplay = loading
    ? "Loading insights..."
    : cacheStatus === "cached"
    ? `Loaded from cache · ${timeLabel}`
    : `Last updated · ${timeLabel}`;

  return (
    <header className="header">
      <div className="header-top">
        <div className="brand">
          <span className="brand-mark">§</span>
          <span className="brand-name">SECRETARY</span>
        </div>
        <div className="status">
          <span className={`status-dot ${loading ? "loading" : ""}`} />
          <span className="status-text">{statusDisplay}</span>
        </div>
      </div>
      <nav className="tabs">
        {pages.map((p) => (
          <button
            key={p.id}
            className={`tab ${activePage === p.id ? "tab-active" : ""}`}
            onClick={() => onChangePage(p.id)}
          >
            {p.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
