import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the UI runs on :5173 and talks to the app server on :8765 (see src/rpc.ts).
export default defineConfig({ plugins: [react()] });
