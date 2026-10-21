// Mirrors pi packages/coding-agent/src/cli/args.ts (pinned 16f5f0af4): command-line arguments.
// edupi has pi's --mode, --model and the basic session flags, plus --faux and --faux-log for
// tests (pi's faux provider is a test library, not a flag).

export interface Args {
  mode?: "rpc";
  model?: string;
  session?: string; // a session file to open (pi also takes a partial session id)
  continue?: boolean; // open the newest session of this cwd
  noSession?: boolean; // keep the session in memory only
  offline?: boolean; // do not read OpenRouter's model list (pi: --offline, also PI_OFFLINE)
  faux?: string; // faux script file: answer from scripted replies instead of OpenRouter
  fauxLog?: string; // append every request the faux provider gets to this JSONL file
  diagnostics: { type: "error"; message: string }[];
}

export function parseArgs(args: string[]): Args {
  const result: Args = { diagnostics: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode") {
      const mode = args[++i];
      if (mode !== "rpc") result.diagnostics.push({ type: "error", message: `Invalid mode "${mode}". edupi has only: rpc` });
      else result.mode = mode;
    } else if (arg === "--model" && i + 1 < args.length) {
      result.model = args[++i];
    } else if (arg === "--session" && i + 1 < args.length) {
      result.session = args[++i];
    } else if (arg === "--continue" || arg === "-c") {
      result.continue = true;
    } else if (arg === "--no-session") {
      result.noSession = true;
    } else if (arg === "--offline") {
      result.offline = true;
    } else if (arg === "--faux" && i + 1 < args.length) {
      result.faux = args[++i];
    } else if (arg === "--faux-log" && i + 1 < args.length) {
      result.fauxLog = args[++i];
    } else {
      result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
    }
  }
  return result;
}
