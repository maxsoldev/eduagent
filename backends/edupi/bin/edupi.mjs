#!/usr/bin/env node
// edupi's entry point (pi: packages/coding-agent/src/rpc-entry.ts and cli.ts). It registers tsx,
// so Node runs the TypeScript sources directly with no build step, then starts main().
// Usage: node bin/edupi.mjs --mode rpc [--model <openrouter model id>] [--faux script.json [--faux-log requests.jsonl]]
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/coding-agent/main.ts");
await main(process.argv.slice(2));
