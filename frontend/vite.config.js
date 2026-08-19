import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // While running "npm run dev", any call to /api/... goes to the backend.
      "/api": "http://localhost:3001"
    }
  }
});
