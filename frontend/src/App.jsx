import { useEffect, useState } from "react";
import Header from "./components/Header.jsx";
import BriefingPage from "./components/BriefingPage.jsx";
import CommunicationsPage from "./components/CommunicationsPage.jsx";
import CalendarPage from "./components/CalendarPage.jsx";
import InvestmentsPage from "./components/InvestmentsPage.jsx";
import NewsPage from "./components/NewsPage.jsx";
import OpportunitiesPage from "./components/OpportunitiesPage.jsx";

const PAGES = [
  { id: "briefing", label: "Briefing" },
  { id: "communications", label: "Communications" },
  { id: "calendar", label: "Schedule" },
  { id: "investments", label: "Investments" },
  { id: "news", label: "Market News" },
  { id: "opportunities", label: "Investment Possibilities" }
];

export default function App() {
  const [activePage, setActivePage] = useState("briefing");
  const [briefing, setBriefing] = useState({ insights: [], generatedAt: null });
  const [portfolioData, setPortfolioData] = useState(null);
  const [opportunity, setOpportunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cacheStatus, setCacheStatus] = useState("unknown");

  // --- Data loaders ---
  async function loadBriefing() {
    const res = await fetch("/api/insights");
    const data = await res.json();
    setBriefing(data);
    if (data.cachedAt) {
      setCacheStatus("cached");
    } else {
      setCacheStatus("fresh");
    }
  }

  async function loadPortfolio() {
    const res = await fetch("/api/portfolio");
    const data = await res.json();
    setPortfolioData(data);
  }

  async function loadOpportunity() {
    try {
      const res = await fetch("/api/opportunity");
      const data = await res.json();
      if (data.ticker) {
        setOpportunity(data);
      }
    } catch (err) {
      console.warn("Failed to load opportunity:", err);
    }
  }

  // --- Modular refresh functions (isolated) ---
  async function refreshBriefing() {
    setLoading(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await loadBriefing();
    } finally {
      setLoading(false);
    }
  }

  async function refreshCommunications() {
    setLoading(true);
    try {
      await fetch("/api/refresh-emails", { method: "POST" });
      await loadBriefing();
    } finally {
      setLoading(false);
    }
  }

  async function refreshSchedule() {
    setLoading(true);
    try {
      await fetch("/api/refresh-calendar", { method: "POST" });
      await loadBriefing();
    } finally {
      setLoading(false);
    }
  }

  async function refreshInvestments() {
    setLoading(true);
    try {
      await loadPortfolio();
    } finally {
      setLoading(false);
    }
  }

  async function refreshOpportunities() {
    setLoading(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await loadOpportunity();
    } finally {
      setLoading(false);
    }
  }

  // --- Full pipeline refresh (header button) ---
  async function refreshAll() {
    setLoading(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await Promise.all([loadBriefing(), loadPortfolio(), loadOpportunity()]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([loadBriefing(), loadPortfolio(), loadOpportunity()]).finally(() => setLoading(false));

    // Poll for updates every 60s
    const interval = setInterval(() => {
      loadBriefing();
      loadOpportunity();
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app">
      <Header
        pages={PAGES}
        activePage={activePage}
        onChangePage={setActivePage}
        generatedAt={briefing.generatedAt}
        loading={loading}
        cacheStatus={cacheStatus}
        onRefresh={refreshAll}
      />
      <main className="main">
        {activePage === "briefing" && (
          <BriefingPage
            insights={briefing.insights}
            loading={loading}
            onRefresh={refreshBriefing}
            generatedAt={briefing.generatedAt}
          />
        )}
        {activePage === "communications" && (
          <CommunicationsPage
            insights={briefing.insights}
            loading={loading}
            onRefresh={refreshCommunications}
            generatedAt={briefing.generatedAt}
          />
        )}
        {activePage === "calendar" && (
          <CalendarPage
            insights={briefing.insights}
            loading={loading}
            onRefresh={refreshSchedule}
            generatedAt={briefing.generatedAt}
          />
        )}
        {activePage === "investments" && (
          <InvestmentsPage
            portfolio={portfolioData?.portfolio}
            news={portfolioData?.news}
            loading={loading}
            onRefresh={refreshInvestments}
          />
        )}
        {activePage === "news" && (
          <NewsPage
            insights={briefing.insights}
            news={portfolioData?.news}
            loading={loading}
            onRefresh={refreshInvestments}
          />
        )}
        {activePage === "opportunities" && (
          <OpportunitiesPage
            opportunity={opportunity}
            loading={loading}
            onRefresh={refreshOpportunities}
          />
        )}
      </main>
    </div>
  );
}
