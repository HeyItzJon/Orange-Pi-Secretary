import { useState, useEffect } from "react";

export default function MarketStatus() {
  const [status, setStatus] = useState({
    isOpen: false,
    message: "Loading...",
    nextEvent: ""
  });

  useEffect(() => {
    function getMarketStatus() {
      const now = new Date();

      // Get ET time (both US and TSX use ET)
      const etTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = etTime.getDay();
      const hours = etTime.getHours();
      const minutes = etTime.getMinutes();
      const totalMinutes = hours * 60 + minutes;

      // Market hours: 9:30 AM (570 min) to 4:00 PM (960 min), Monday-Friday
      const marketOpen = 570; // 9:30 AM
      const marketClose = 960; // 4:00 PM
      const isWeekday = day >= 1 && day <= 5; // Mon-Fri

      let isOpen = false;
      let message = "";
      let nextEvent = "";

      if (!isWeekday) {
        // Weekend
        const daysUntilMonday = day === 0 ? 1 : 8 - day;
        isOpen = false;
        message = `Markets closed (${daysUntilMonday} day${daysUntilMonday > 1 ? "s" : ""} until next open)`;
        nextEvent = "Opens Monday 9:30 AM ET";
      } else if (totalMinutes < marketOpen) {
        // Before market open
        const minutesUntilOpen = marketOpen - totalMinutes;
        const h = Math.floor(minutesUntilOpen / 60);
        const m = minutesUntilOpen % 60;
        isOpen = false;
        message = `Markets closed (opens in ${h}h ${m}m)`;
        nextEvent = "Opens 9:30 AM ET";
      } else if (totalMinutes < marketClose) {
        // Market open
        const minutesUntilClose = marketClose - totalMinutes;
        const h = Math.floor(minutesUntilClose / 60);
        const m = minutesUntilClose % 60;
        isOpen = true;
        message = `🟢 Markets open (closes in ${h}h ${m}m)`;
        nextEvent = "Closes 4:00 PM ET";
      } else {
        // After market close
        const minutesUntilTomorrow = 1440 - totalMinutes + marketOpen; // Rest of today + 9:30 AM tomorrow
        const h = Math.floor(minutesUntilTomorrow / 60);
        const m = minutesUntilTomorrow % 60;
        isOpen = false;
        message = `Markets closed (opens in ${h}h ${m}m)`;
        nextEvent = "Opens tomorrow 9:30 AM ET";
      }

      setStatus({ isOpen, message, nextEvent });
    }

    getMarketStatus();
    const interval = setInterval(getMarketStatus, 60000); // Update every minute
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="market-status">
      <div className="market-status-content">
        <div className="market-status-main">{status.message}</div>
        <div className="market-status-sub">{status.nextEvent}</div>
      </div>
    </div>
  );
}
