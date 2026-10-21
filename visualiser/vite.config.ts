import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite may pick any free port (5173, 5174, ...). The page always talks to its own origin;
// Vite forwards /rpc (WebSocket) and /guide to the app server. Override with EDUCODEX_SERVER.
const server = process.env.EDUCODEX_SERVER ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/rpc": { target: server, ws: true },
      "/guide": { target: server },
    },
  },
});
