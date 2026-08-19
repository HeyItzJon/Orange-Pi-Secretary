import InsightCard from "./InsightCard.jsx";

export default function NewsPage({ insights, news, loading, onRefresh }) {
  if (loading) return <div className="empty-state">Loading market news and insights...</div>;

  const investmentInsights = insights?.filter(i => i.category === "investment") || [];
  const hasContent = (investmentInsights && investmentInsights.length > 0) || (news && news.length > 0);

  if (!hasContent) return <div className="empty-state">No market data available yet.</div>;

  return (
    <div className="news-container">
      {/* Header with refresh */}
      <div className="briefing-header">
        <h2>Market Intelligence</h2>
        {onRefresh && (
          <button className="refresh-btn" onClick={onRefresh}>↻ Refresh</button>
        )}
      </div>

      {/* Investment insights */}
      {investmentInsights && investmentInsights.length > 0 && (
        <div className="insights-section">
          <h3 className="section-title">Investment Insights</h3>
          <div className="insights-stack">
            {investmentInsights.map((insight, i) => (
              <InsightCard key={i} {...insight} />
            ))}
          </div>
        </div>
      )}

      {/* Market news */}
      {news && news.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Market News</h2>
          <ul className="news-list">
            {news.map((headline, i) => (
              <li key={i}>{headline}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
