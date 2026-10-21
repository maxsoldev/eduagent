import { defineConfig } from "@playwright/test";
import { E2E_DIR, PORT } from "./e2e/env";

// The launcher serves the built UI and starts backends from launcher/backends.test.json:
// educodex replays backends/educodex/examples/fake/demo.json instead of calling a model.
// edupi-resume opens a copy of a session file the real pi wrote (resume/).
export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1500, height: 900 } },
	webServer: {
		command: `bash -c 'rm -rf ${E2E_DIR} && mkdir -p ${E2E_DIR}/home ${E2E_DIR}/ws ${E2E_DIR}/ws2 ${E2E_DIR}/resume && cp ../backends/edupi/test/fixtures/pi/session-prompt-and-tools.jsonl ${E2E_DIR}/resume/ && cd .. && E2E_DIR=${E2E_DIR} pnpm --silent eduagent --config backends.test.json --port ${PORT} --cwd ${E2E_DIR}/ws'`,
		url: `http://127.0.0.1:${PORT}/backends`,
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
