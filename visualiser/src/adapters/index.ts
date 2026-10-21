// One adapter per protocol. The viewer picks it from the "protocol" of the backend entry in
// the launcher's list (GET /backends); the native handshake does not change.
import type { AdapterModule } from "./types";
import { codexAdapter } from "./codex";

export const ADAPTERS: Record<string, AdapterModule> = {
  [codexAdapter.protocol]: codexAdapter,
};
