import { defineConfig } from "@playwright/test";

// The app server serves the built UI and replays examples/fake/demo.json instead of calling a model.
const PORT = 8799;
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1500, height: 900 } },
  webServer: {
    command: `bash -c 'rm -rf /tmp/edx-e2e && mkdir -p /tmp/edx-e2e && cd .. && uv run -q educodex app-server --listen ws://127.0.0.1:${PORT} --cwd /tmp/edx-e2e --fake-model examples/fake/demo.json'`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
