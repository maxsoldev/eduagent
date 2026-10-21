// One adapter per protocol. The viewer picks it from the "protocol" of the backend entry in
// the launcher's list (GET /backends); the native handshake does not change.

import { codexAdapter } from "./codex";
import { piAdapter } from "./pi";
import type { AdapterModule } from "./types";

export const ADAPTERS: Record<string, AdapterModule> = {
	[codexAdapter.protocol]: codexAdapter,
	[piAdapter.protocol]: piAdapter,
};
