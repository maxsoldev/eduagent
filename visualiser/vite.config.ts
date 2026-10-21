import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite may pick any free port (5173, 5174, ...). The page always talks to its own origin;
// Vite forwards /backends (the list and the per-viewer WebSockets) and /guide to the launcher
// (`pnpm eduagent`). Override the launcher address with EDUAGENT_LAUNCHER.
const launcher = process.env.EDUAGENT_LAUNCHER ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/backends": { target: launcher, ws: true },
      "/guide": { target: launcher },
    },
  },
});
