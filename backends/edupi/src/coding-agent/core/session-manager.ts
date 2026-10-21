// Mirrors pi packages/coding-agent/src/core/session-manager.ts (pinned 16f5f0af4): sessions as
// append-only JSONL files. Line 1 is a header; every other line is an entry with an id and the
// id of its parent, so the entries form a tree. pi can branch the tree; edupi writes one linear
// branch, where each entry's parent is the entry before it. The context for the model is not
// stored: it is rebuilt from the entries (buildSessionContext).
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage } from "../../agent/types.ts";
import type { Message, SystemMessage, Usage } from "../../ai/types.ts";
import { uuidv7 } from "../../ai/utils/uuid.ts";
import { getAgentDir } from "../config.ts";
import { createCompactionSummaryMessage } from "./messages.ts";

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
  type: "session";
  version?: number; // v1 sessions don't have this
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

/**
 * Everything before firstKeptEntryId, summarized. The context restarts from here: the system
 * message, the summary, then the kept entries.
 */
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T; // pi: { readFiles, modifiedFiles }
  usage?: Usage; // of the summarization call
  fromHook?: boolean; // true if an extension wrote it
  systemMessage?: SystemMessage; // the system prompt and tools at this point
}

/** The entry types edupi reads and writes. pi has more (label, custom, branch_summary, ...). */
export type SessionEntry = SessionMessageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | CompactionEntry;

/** A line of a session file: the header or an entry. */
export type FileEntry = SessionHeader | SessionEntry;

/** What the model sees, rebuilt from the entries, plus the settings in force. */
export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** A short id: 8 hex chars, checked against the ids in use. */
function generateId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return randomUUID(); // fallback if somehow every short id collides
}

/** One entry per line. Malformed lines are skipped, as in pi. */
export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
  if (!existsSync(filePath)) return [];
  return parseSessionEntries(readFileSync(filePath, "utf8"));
}

/** The path from the root to the leaf: walk parentId up from the leaf, then reverse. */
function buildSessionPath(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const leaf = (leafId ? byId.get(leafId) : undefined) ?? entries[entries.length - 1];
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/** The last thinking level and model on the path. An assistant message names its model too. */
function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { thinkingLevel, model };
}

/** The messages one entry adds to the context. Setting entries add none. */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
  if (entry.type === "message") return [entry.message];
  if (entry.type === "compaction") {
    const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
    return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
  }
  return [];
}

/**
 * The entries that make up the context. Without a compaction: the whole path. With one: the
 * latest compaction, the entries from its firstKeptEntryId up to it (without system messages,
 * the compaction brings its own), then every entry after it. Older entries are left out.
 */
export function buildContextEntries(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  const path = buildSessionPath(entries, leafId);
  let compaction: CompactionEntry | undefined;
  for (const entry of path) if (entry.type === "compaction") compaction = entry;
  if (!compaction) return path;

  const compactionIdx = path.indexOf(compaction);
  const contextEntries: SessionEntry[] = [compaction];
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i];
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) contextEntries.push(entry);
  }
  contextEntries.push(...path.slice(compactionIdx + 1));
  return contextEntries;
}

/** Rebuilds the model's context from the entries on the path to the leaf. */
export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const path = buildSessionPath(entries, leafId);
  const { thinkingLevel, model } = getSessionContextSettings(path);
  // An older compaction can sit inside the kept range. Only the latest one (index 0) adds messages.
  const messages = buildContextEntries(entries, leafId)
    .flatMap((entry, index) => (entry.type === "compaction" && index > 0 ? [] : sessionEntryToContextMessages(entry)));
  return { messages, thinkingLevel, model };
}

/** <agentDir>/sessions/--<cwd without the leading /, with / \ : as ->--, created if missing. */
export function getDefaultSessionDir(cwd: string, agentDir: string = getAgentDir()): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(resolve(agentDir), "sessions", safePath);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

/**
 * Manages one session file. Appending makes the new entry a child of the current leaf and
 * moves the leaf to it. The file is created only once the session has a user or assistant
 * message, so starting and closing edupi without a chat leaves no file behind.
 */
export class SessionManager {
  private sessionId = "";
  private sessionFile: string | undefined;
  private sessionDir: string;
  private cwd: string;
  private persist: boolean;
  private flushed = false;
  private fileEntries: FileEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;

  private constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean) {
    this.cwd = resolve(cwd);
    this.sessionDir = sessionDir;
    this.persist = persist;
    if (persist && sessionDir && !existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    if (sessionFile) this._setSessionFile(sessionFile);
    else this.newSession();
  }

  private _setSessionFile(sessionFile: string): void {
    this.sessionFile = resolve(sessionFile);
    const entries = loadEntriesFromFile(this.sessionFile);
    if (entries.length === 0) {
      // A missing file starts a new session at that path; a file that is not a session is an error.
      if (existsSync(this.sessionFile) && statSync(this.sessionFile).size > 0) {
        throw new Error(`Session file is not a valid edupi session: ${this.sessionFile}`);
      }
      const explicitPath = this.sessionFile;
      this.newSession();
      this.sessionFile = explicitPath;
      return;
    }
    const header = entries.find((e): e is SessionHeader => e.type === "session");
    if (!header) throw new Error(`Session file has no header: ${this.sessionFile}`);
    if ((header.version ?? 1) < CURRENT_SESSION_VERSION) {
      throw new Error(`Session file version ${header.version ?? 1} is not supported (edupi reads version ${CURRENT_SESSION_VERSION})`);
    }
    this.fileEntries = entries;
    this.sessionId = header.id;
    this.flushed = true;
    this._buildIndex();
  }

  /** Starts a fresh session in memory: a new header and id. Returns the file it will write. */
  newSession(options?: { parentSession?: string }): string | undefined {
    this.sessionId = uuidv7();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.leafId = null;
    this.flushed = false;
    if (this.persist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.sessionDir, `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
  }

  /** The leaf is the last entry of the file. */
  private _buildIndex(): void {
    this.byId.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
    }
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  private _hasConversation(): boolean {
    return this.fileEntries.some((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
  }

  /** The first conversation message writes every entry so far; after that, one line per entry. */
  private _persist(entry: SessionEntry): void {
    if (!this.persist || !this.sessionFile) return;
    if (!this.flushed) {
      if (!this._hasConversation()) return;
      const fd = openSync(this.sessionFile, "wx");
      try {
        for (const e of this.fileEntries) writeFileSync(fd, `${JSON.stringify(e)}\n`);
      } finally {
        closeSync(fd);
      }
      this.flushed = true;
    } else {
      appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
    }
  }

  private _appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this._persist(entry);
  }

  private _entryBase(): { id: string; parentId: string | null; timestamp: string } {
    return { id: generateId(this.byId), parentId: this.leafId, timestamp: new Date().toISOString() };
  }

  /** Appends a message as a child of the leaf. Returns the entry id. */
  appendMessage(message: Message): string {
    const entry: SessionMessageEntry = { type: "message", ...this._entryBase(), message };
    this._appendEntry(entry);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = { type: "thinking_level_change", ...this._entryBase(), thinkingLevel };
    this._appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = { type: "model_change", ...this._entryBase(), provider, modelId };
    this._appendEntry(entry);
    return entry.id;
  }

  getHeader(): SessionHeader | null {
    return this.fileEntries.find((e): e is SessionHeader => e.type === "session") ?? null;
  }

  /** All entries, without the header. */
  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
  }

  /** The entries from the root to the leaf. */
  getBranch(): SessionEntry[] {
    return buildSessionPath(this.getEntries(), this.leafId);
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId);
  }

  /** A new session in <agentDir>/sessions/<cwd folder>/, or in sessionDir. */
  static create(cwd: string, sessionDir?: string): SessionManager {
    return new SessionManager(cwd, sessionDir ?? getDefaultSessionDir(cwd), undefined, true);
  }

  /** Opens a session file. Its cwd comes from the header; new sessions go next to the file. */
  static open(path: string, sessionDir?: string): SessionManager {
    const header = loadEntriesFromFile(resolve(path)).find((e): e is SessionHeader => e.type === "session");
    return new SessionManager(header?.cwd ?? process.cwd(), sessionDir ?? resolve(path, ".."), path, true);
  }

  /** Opens the newest session of this cwd, or starts a new one. */
  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    const mostRecent = findMostRecentSession(dir);
    return new SessionManager(cwd, dir, mostRecent ?? undefined, true);
  }

  /** A session that is never written to disk (pi's --no-session). */
  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd, "", undefined, false);
  }
}

/** The .jsonl file in the dir that was changed last. */
export function findMostRecentSession(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(sessionDir, f))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
}
