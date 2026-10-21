// Mirrors pi packages/coding-agent/src/modes/rpc/rpc-mode.ts (pinned 16f5f0af4): RPC mode, pi's
// headless protocol over stdin/stdout. Commands come in as JSON lines with a `type` and an
// optional `id`. Each command gets one {type: "response", command, id, success} line. Every
// session event goes out as its own line. Lines are handled concurrently, so a slow command does
// not block a later one, and clients match responses by id.
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc-types.ts";

/**
 * Keeps stdout for protocol lines only: anything else that writes to stdout (console.log) goes
 * to stderr. Mirrors pi's takeOverStdout (core/output-guard.ts). Returns the real stdout writer.
 */
function takeOverStdout(): (line: string, done?: () => void) => void {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  return (line, done) => {
    write(line, done);
  };
}

export interface RpcModeOptions {
  /** edupi: gets the protocol line writer, so the tracer can send trace messages on stdout. */
  connect?: (output: (message: object) => void) => void;
}

export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions = {}): Promise<never> {
  const writeRawStdout = takeOverStdout();
  let session = runtimeHost.session;
  let unsubscribe: (() => void) | undefined;

  const output = (obj: RpcResponse | object) => writeRawStdout(serializeJsonLine(obj));
  options.connect?.(output);

  const success = (id: string | undefined, command: string, data?: object | null): RpcResponse => {
    if (data === undefined) return { id, type: "response", command, success: true } as RpcResponse;
    return { id, type: "response", command, success: true, data } as RpcResponse;
  };

  const error = (id: string | undefined, command: string, message: string): RpcResponse => {
    return { id, type: "response", command, success: false, error: message };
  };

  /** Points the mode at the runtime's current session (it changes on new_session). */
  const rebindSession = () => {
    session = runtimeHost.session;
    unsubscribe?.();
    unsubscribe = session.subscribe((event) => output(toJsonEvent(event)));
  };
  rebindSession();

  const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
    const id = command.id;

    switch (command.type) {
      case "prompt": {
        // The response is written once the prompt is accepted, before the run's events.
        // Failures after that are events (an assistant message with stopReason "error").
        let preflightSucceeded = false;
        void session
          .prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            preflightResult: (disposition) => {
              preflightSucceeded = true;
              output(success(id, "prompt", { disposition }));
            },
          })
          .catch((e) => {
            if (!preflightSucceeded) output(error(id, "prompt", e.message));
          });
        return undefined;
      }

      case "get_state": {
        const state: RpcSessionState = {
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          autoCompactionEnabled: session.autoCompactionEnabled,
          messageCount: session.messages.length,
          pendingMessageCount: session.pendingMessageCount,
        };
        return success(id, "get_state", state);
      }

      case "new_session": {
        const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
        const result = await runtimeHost.newSession(options);
        if (!result.cancelled) rebindSession();
        return success(id, "new_session", result);
      }

      case "get_messages": {
        return success(id, "get_messages", { messages: session.messages });
      }

      default: {
        const unknownCommand = command as { type: string };
        return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
      }
    }
  };

  const handleInputLine = async (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (parseError: unknown) {
      output(error(undefined, "parse", `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
      return;
    }
    const command = parsed as RpcCommand;
    try {
      const response = await handleCommand(command);
      if (response) output(response);
    } catch (commandError: unknown) {
      output(error(command.id, command.type, commandError instanceof Error ? commandError.message : String(commandError)));
    }
  };

  // The client closes stdin to end the session. SIGTERM (the launcher) exits with 143, as in pi.
  process.stdin.on("end", () => writeRawStdout("", () => process.exit(0))); // flush stdout first
  process.on("SIGTERM", () => process.exit(143));
  attachJsonlLineReader(process.stdin, (line) => {
    void handleInputLine(line);
  });

  return new Promise(() => {}); // keep the process alive
}
