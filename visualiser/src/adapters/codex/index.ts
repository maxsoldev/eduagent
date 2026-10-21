// The Codex app-server adapter (protocol "codex-app-server"), used by educodex.
import type { AdapterModule } from "../types";
import { createCodexAdapter } from "./client";
import { codexComponents } from "./components";
import { PROTOCOL } from "./mapping";

export const codexAdapter: AdapterModule = {
  protocol: PROTOCOL,
  create: createCodexAdapter,
  defaults: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  ...codexComponents,
};
