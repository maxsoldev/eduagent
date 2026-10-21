// Mirrors pi packages/coding-agent/src/core/agent-session-runtime.ts (pinned 16f5f0af4): holds the
// current AgentSession and replaces it. pi's new_session does not clear the old session: it
// builds a new SessionManager (a new file) and a new AgentSession around it, and the mode
// re-subscribes to the new session. edupi has new_session only (no resume, fork or clone).
import type { AgentSession } from "./agent-session.ts";
import { SessionManager } from "./session-manager.ts";

export type CreateRuntime = (sessionManager: SessionManager) => AgentSession;

export class AgentSessionRuntime {
  private _session: AgentSession;

  constructor(session: AgentSession, private readonly cwd: string, private readonly createRuntime: CreateRuntime) {
    this._session = session;
  }

  get session(): AgentSession {
    return this._session;
  }

  /** A fresh session in the same session dir (in memory if the old one was not saved). */
  async newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }> {
    const old = this._session.sessionManager;
    const sessionManager = old.isPersisted() ? SessionManager.create(this.cwd, old.getSessionDir()) : SessionManager.inMemory(this.cwd);
    if (options?.parentSession) sessionManager.newSession({ parentSession: options.parentSession });
    await this.teardownCurrent();
    this._session = this.createRuntime(sessionManager);
    return { cancelled: false };
  }

  /** pi aborts the active run first, so it is saved in the old file. edupi waits for it. */
  private async teardownCurrent(): Promise<void> {
    await this._session.agent.waitForIdle();
    this._session.dispose();
  }
}
