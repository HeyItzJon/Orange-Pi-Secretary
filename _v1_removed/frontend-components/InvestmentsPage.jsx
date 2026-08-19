import MarketStatus from "./MarketStatus.jsx";

export default function InvestmentsPage({ portfolio, news, loading, onRefresh }) {
  if (loading) return <div className="empty-state">Loading portfolio...</div>;
  if (!portfolio) return <div className="empty-state">No portfolio data yet.</div>;

  return (
    <div className="investments">
      {onRefresh && (
        <div style={{ paddingBottom: "1rem", borderBottom: "1px solid #ddd", marginBottom: "1rem" }}>
          <button className="refresh-btn" onClick={onRefresh}>↻ Refresh Portfolio</button>
        </div>
      )}

      <MarketStatus />

      <section className="panel">
        <h2 className="panel-title">Holdings</h2>
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Sector</th>
              <th>Price</th>
              <th>Day</th>
              <th>Weight</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.holdings.map((h) => (
              <tr key={h.ticker}>
                <td className="mono">
                  {h.ticker}
                  {h.stale && <span className="stale-dot" title="Showing last known price">•</span>}
                </td>
                <td>{h.sector}</td>
                <td className="mono">
                  {h.price != null ? `${h.price.toFixed(2)} ${h.currency || ""}` : "—"}
                </td>
                <td className={`mono ${h.dayChangePct >= 0 ? "positive" : "negative"}`}>
                  {h.dayChangePct != null ? `${h.dayChangePct >= 0 ? "+" : ""}${h.dayChangePct.toFixed(2)}%` : "—"}
                </td>
                <td className="mono">{h.weightPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="panel-footnote">
          Last rebalanced {portfolio.lastRebalanced}
          {portfolio.holdings.some(h => h.stale) && " · some prices are cached (last successful fetch)"}
        </p>
      </section>

    </div>
  );
}
