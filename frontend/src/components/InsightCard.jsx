// InsightCard.jsx
// Individual insight with category color, priority badge, and concise text

const CATEGORY_COLORS = {
  sector: "#E8A23D",
  trends: "#6FA8DC",
  macro: "#7FA88C",
  geopolitical: "#B98FC9",
  action: "#E84C3D",
  deadline: "#F1C40F",
  decision: "#9B59B6",
  update: "#27AE60",
  email: "#3498DB",
  important: "#E74C3C",
  busy: "#F39C12",
  conflict: "#C0392B",
  prep: "#8E44AD",
  calendar: "#16A085"
};

const CATEGORY_LABELS = {
  sector: "Sector Analysis",
  trends: "Industry Trends",
  macro: "Macro Context",
  geopolitical: "Geopolitical",
  action: "Action Required",
  deadline: "Deadline",
  decision: "Decision Needed",
  update: "Important Update",
  email: "Communication",
  important: "Important Event",
  busy: "Busy Day",
  conflict: "Time Conflict",
  prep: "Prep Needed",
  calendar: "Schedule"
};

const PRIORITY_LABELS = {
  high: "🔴 High",
  medium: "🟡 Medium",
  low: "🟢 Low"
};

export default function InsightCard({ category, text, priority = "medium" }) {
  const bgColor = CATEGORY_COLORS[category] || "#999";
  const label = CATEGORY_LABELS[category] || category;
  const priorityLabel = PRIORITY_LABELS[priority] || priority;

  return (
    <div className="insight-card">
      <div className="insight-header">
        <div className="insight-category" style={{ backgroundColor: bgColor }}>
          {label}
        </div>
        <span className="insight-priority">{priorityLabel}</span>
      </div>
      <p className="insight-text">{text}</p>
    </div>
  );
}
