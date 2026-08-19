export default function OpportunitiesPage({ opportunity, loading, onRefresh }) {
  if (loading) return <div className="empty-state">Researching today's opportunity...</div>;
  if (!opportunity || !opportunity.ticker) {
    return <div className="empty-state">No opportunity generated yet. Check back tomorrow.</div>;
  }

  return (
    <div className="investments">
      {onRefresh && (
        <div style={{ paddingBottom: "1rem", borderBottom: "1px solid #ddd", marginBottom: "1rem" }}>
          <button className="refresh-btn" onClick={onRefresh}>↻ Refresh Opportunity</button>
        </div>
      )}

      <section className="panel opportunity-panel">
        <div className="opportunity-header">
          <div>
            <h2 className="panel-title">{opportunity.company}</h2>
            <p className="opportunity-ticker">{opportunity.ticker}</p>
          </div>
          <div className="opportunity-date">
            {new Date(opportunity.generatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric"
            })}
          </div>
        </div>

        <div className="opportunity-section">
          <h3 className="opportunity-subheading">The Pitch</h3>
          <p className="opportunity-text">{opportunity.pitch}</p>
        </div>

        <div className="opportunity-section">
          <h3 className="opportunity-subheading">Evidence</h3>
          <p className="opportunity-text">{opportunity.evidence}</p>
        </div>

        <div className="opportunity-section">
          <h3 className="opportunity-subheading">Your Thesis Alignment</h3>
          <p className="opportunity-text">{opportunity.thesis}</p>
        </div>

        <p className="opportunity-note">
          This is research, not a recommendation. Do your own diligence before any trade.
        </p>
      </section>
    </div>
  );
}
