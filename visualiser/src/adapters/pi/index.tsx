// The pi RPC adapter (protocol "pi-rpc"), used by the real pi and by edupi. Its one backend-only
// part is the edit tool's diff (components.tsx).
import type { AdapterModule } from "../types";
import { createPiAdapter } from "./client";
import { NativeEntry } from "./components";
import { PROTOCOL } from "./mapping";

export const piAdapter: AdapterModule = {
  protocol: PROTOCOL,
  create: createPiAdapter,
  defaults: {},
  NativeEntry,
  ApprovalCard: () => null, // pi has no approvals
};
