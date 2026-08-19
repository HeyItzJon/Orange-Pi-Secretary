import InsightCard from "./InsightCard.jsx";

export default function CalendarPage({ insights, loading, onRefresh, generatedAt }) {
  const calendarInsights = insights.filter(i => i.category === "calendar");

  if (loading) {
    return <div className="empty-state">Reading your schedule...</div>;
  }

  if (!calendarInsights || calendarInsights.length === 0) {
    return (
      <div className="empty-state">
        <p>No schedule alerts for the next 5 days.</p>
        <button className="refresh-btn" onClick={onRefresh}>Check schedule now</button>
      </div>
    );
  }

  return (
    <div className="briefing-container">
      <div className="briefing-header">
        <h2>Your Schedule</h2>
        <div className="briefing-header-right">
          {generatedAt && (
            <span className="briefing-timestamp">
              {new Date(generatedAt).toLocaleString()}
            </span>
          )}
          <button className="refresh-btn" onClick={onRefresh}>↻ Refresh</button>
        </div>
      </div>
      <div className="insights-stack">
        {calendarInsights.map((insight, i) => (
          <InsightCard key={i} {...insight} />
        ))}
      </div>
    </div>
  );
}
