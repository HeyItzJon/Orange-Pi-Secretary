import InsightCard from "./InsightCard.jsx";

export default function CommunicationsPage({ insights, loading, onRefresh, generatedAt }) {
  // Filter for email category insights only
  const emailInsights = insights.filter(i => i.category === "email");

  if (loading) {
    return <div className="empty-state">Reading your messages...</div>;
  }

  if (!emailInsights || emailInsights.length === 0) {
    return (
      <div className="empty-state">
        <p>No pending communications.</p>
        <button className="refresh-btn" onClick={onRefresh}>Check emails now</button>
      </div>
    );
  }

  return (
    <div className="briefing-container">
      {/* Header with timestamp and refresh button */}
      <div className="briefing-header">
        <h2>Communications</h2>
        <div className="briefing-header-right">
          {generatedAt && (
            <span className="briefing-timestamp">
              {new Date(generatedAt).toLocaleString()}
            </span>
          )}
          <button className="refresh-btn" onClick={onRefresh} title="Check emails now">
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Email actions — lean and direct */}
      <div className="insights-stack">
        {emailInsights.map((insight, i) => (
          <InsightCard key={i} {...insight} />
        ))}
      </div>
    </div>
  );
}
