// Mirrors pi packages/coding-agent/src/config.ts (pinned 16f5f0af4): the app name and the home
// ("agent dir") paths. pi's home is ~/.pi/agent; edupi's is ~/.eduagent/.edupi/agent, with the
// same inner layout, so eduagent never touches the real pi's files. An environment variable
// overrides it, as PI_CODING_AGENT_DIR does for pi (tests use a temporary home).
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_NAME = "edupi";
/** The suite folder in the user's home, then edupi's folder in it (pi: ".pi"). */
export const CONFIG_DIR_NAME = join(".eduagent", ".edupi");
/** Project resources (skills, SYSTEM.md) live in <cwd>/.pi, pi's project folder name. */
export const PROJECT_CONFIG_DIR_NAME = ".pi";

// pi: `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, so PI_CODING_AGENT_DIR there.
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

/** Expands a leading ~ to the user's home. */
export function expandTildePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

/** The agent config directory, e.g. ~/.eduagent/.edupi/agent/. */
export function getAgentDir(): string {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) return expandTildePath(envDir);
  return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** The sessions directory: one subfolder per working directory. */
export function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}
