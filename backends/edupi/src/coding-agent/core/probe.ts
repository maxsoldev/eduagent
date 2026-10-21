// edupi only (pi has no probe): the hook points the core calls so the teaching extras can watch
// it, as educodex's core/probe.py. The core never imports the observe layer; src/observe/
// implements this interface, and main.ts passes the implementation in. Every hook is optional.
import type { AgentProbe } from "../../agent/types.ts";

/**
 * All hook points. The lower layers cannot import this file, so their hooks are defined there:
 * the provider hooks (model request, stream event, model response) in ai/types.ts, the agent
 * loop hooks (tool dispatch, tool output) in agent/types.ts. Coding-agent hooks are added here.
 */
export interface Probe extends AgentProbe {}
