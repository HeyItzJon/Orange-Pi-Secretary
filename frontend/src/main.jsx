import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Display from "./Display.jsx";

// Two surfaces, one codebase:
//   /          the full interactive dashboard — everything, nothing hidden
//   /display   the always-on screen — glanceable, fixed zones, no input
// No router dependency; the path is all we need to choose.
const isDisplay = window.location.pathname.replace(/\/+$/, "") === "/display";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isDisplay ? <Display /> : <App />}
  </React.StrictMode>
);
