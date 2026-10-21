// edupi only (pi has no probe): the hook points the core calls so the teaching extras can watch
// it, as educodex's core/probe.py. The core never imports the observe layer; src/observe/
// implements this interface, and main.ts passes the implementation in. Every hook is optional.
import type { ProviderProbe } from "../../ai/types.ts";

/**
 * All hook points. The provider hooks (model request, stream event, model response) are defined
 * in the ai layer, which cannot import this file; hooks of higher layers are added here.
 */
export interface Probe extends ProviderProbe {}
