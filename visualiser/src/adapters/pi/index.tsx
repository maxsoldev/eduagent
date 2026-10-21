// The pi RPC adapter (protocol "pi-rpc"), used by the real pi and, later, edupi. pi has no
// backend-only parts yet, so its components are the generic fallbacks.
import type { AdapterModule } from "../types";
import { createPiAdapter } from "./client";
import { PROTOCOL } from "./mapping";

export const piAdapter: AdapterModule = {
  protocol: PROTOCOL,
  create: createPiAdapter,
  defaults: {},
  NativeEntry: ({ part }) => <pre className="small">{JSON.stringify(part.data)}</pre>,
  ApprovalCard: () => null, // pi has no approvals
};
