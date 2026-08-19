import InsightCard from "./InsightCard.jsx";

export default function BriefingPage({ insights, loading, onRefresh, generatedAt }) {
  if (loading) {
    return <div className="empty-state">Reading the room...</div>;
  }

  if (!insights || insights.length === 0) {
    return (
      <div className="empty-state">
        <p>No briefing yet.</p>
        <button className="refresh-btn" onClick={onRefresh}>Run pipeline now</button>
      </div>
    );
  }

  return (
    <div className="briefing-container">
      {/* Header with timestamp and refresh button */}
      <div className="briefing-header">
        <h2>Your Briefing</h2>
        <div className="briefing-header-right">
          {generatedAt && (
            <span className="briefing-timestamp">
              {new Date(generatedAt).toLocaleString()}
            </span>
          )}
          <button className="refresh-btn" onClick={onRefresh} title="Refresh briefing">
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Insights — lean and direct */}
      <div className="insights-stack">
        {insights.map((insight, i) => (
          <InsightCard key={i} {...insight} />
        ))}
      </div>
    </div>
  );
}
