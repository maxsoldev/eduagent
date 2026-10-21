// Mirrors pi packages/coding-agent/src/core/session-manager.ts (pinned 16f5f0af4): sessions as
// append-only JSONL files. Line 1 is a header; every other line is an entry with an id and the
// id of its parent, so the entries form a tree. pi can branch the tree; edupi writes one linear
// branch, where each entry's parent is the entry before it. The context for the model is not
// stored: it is rebuilt from the entries (buildSessionContext).
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage } from "../../agent/types.ts";
import type { Message, SystemMessage, Usage } from "../../ai/types.ts";
import { getCurrentSystemMessage } from "../../ai/utils/transcript.ts";
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

/**
 * A later change to one earlier entry's part of the context. edupi writes only omissions
 * (replacement null): a failed overflow attempt is dropped before the retry. The entry itself stays.
 */
export interface ContextEditEntry extends SessionEntryBase {
	type: "context_edit";
	targetId: string;
	replacement: { content: string | Message["content"] } | null;
}

/** The entry types edupi reads and writes. pi has more (label, custom, branch_summary, ...). */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| ContextEditEntry;

/** A line of a session file: the header or an entry. */
export type FileEntry = SessionHeader | SessionEntry;

/** What the model sees, rebuilt from the entries, plus the settings in force. */
export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

/** One entry of the context and the messages it gives, after context edits. */
export interface ProjectedSessionEntry {
	sourceEntry: SessionEntry;
	messages: AgentMessage[]; // empty for settings entries and omitted ones
}

/** The context with, for each message, the entry it came from (compaction needs both). */
export interface SessionProjection extends SessionContext {
	entries: ProjectedSessionEntry[];
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

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return entry;
	}
	return null;
}

/** The path from the root to the leaf: walk parentId up from the leaf, then reverse. */
function buildSessionPath(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
	if (leafId === null) return []; // a leaf of null means "before the first entry"
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
	if (entry.type === "message") {
		const message = entry.message;
		// Files are read without validation; a hand-edited one can have messages with null content.
		if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
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

/** An entry's messages after its context edit: null drops them, a replacement swaps the content. */
function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
	const messages = sessionEntryToContextMessages(entry);
	if (!edit) return messages;
	const replacement = edit.replacement;
	if (replacement === null) return [];
	return messages.map((message) => {
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return message;
		const content =
			message.role !== "user" && typeof replacement.content === "string"
				? [{ type: "text" as const, text: replacement.content }]
				: replacement.content;
		return { ...message, content } as AgentMessage;
	});
}

/** The context entries, each with the messages it gives after context edits. */
export function buildSessionProjection(entries: SessionEntry[], leafId?: string | null): SessionProjection {
	const path = buildSessionPath(entries, leafId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const contextEntries = buildContextEntries(entries, leafId);
	const edits = new Map<string, ContextEditEntry>();
	for (const entry of contextEntries) if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	const projected = contextEntries.map(
		(sourceEntry, index): ProjectedSessionEntry => ({
			sourceEntry,
			// An older compaction can sit inside the kept range. Only the latest one (index 0) adds messages.
			messages:
				sourceEntry.type === "compaction" && index > 0
					? []
					: projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
		}),
	);
	return { entries: projected, messages: projected.flatMap((e) => e.messages), thinkingLevel, model };
}

/** Rebuilds the model's context from the entries on the path to the leaf. */
export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
	const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId);
	return { messages, thinkingLevel, model };
}

/** <agentDir>/sessions/--<cwd without the leading /, with / \ : as ->--. */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getAgentDir()): string {
	const safePath = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

/** The default session dir for a cwd, created if missing. */
export function getDefaultSessionDir(cwd: string, agentDir: string = getAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

/**
 * Reads a session file. A file whose first entry is not a header gives no entries. A last line
 * without its newline gets one, so the next append starts a new line.
 */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	if (!existsSync(filePath)) return [];
	const content = readFileSync(filePath, "utf8");
	const entries = parseSessionEntries(content);
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") return [];
	if (content && !content.endsWith("\n")) appendFileSync(filePath, "\n");
	return entries;
}

/** The header, if the file's first entry is one. Unreadable files count as no session. */
function readSessionHeader(filePath: string): SessionHeader | null {
	try {
		const first = parseSessionEntries(readFileSync(filePath, "utf8"))[0];
		return first?.type === "session" && typeof first.id === "string" ? first : null;
	} catch {
		return null;
	}
}

/** The session file in the dir that was changed last. Files that are not sessions are skipped. */
export function findMostRecentSession(sessionDir: string): string | null {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		return files.find(({ path }) => readSessionHeader(path))?.path ?? null;
	} catch {
		return null; // no dir, or a file went away while we looked
	}
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
		if (existsSync(this.sessionFile)) {
			const entries = loadEntriesFromFile(this.sessionFile);
			if (entries.length === 0) {
				// An empty file gets a header at once; a file that is not a session is an error.
				const explicitPath = this.sessionFile;
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid edupi session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}
			this._loadEntries(entries);
			this.flushed = true;
		} else {
			// A missing file starts a new session at that path (pi's --session <new file>).
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath;
		}
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

	/** Takes the entries of a loaded file. pi migrates old versions here; edupi refuses them. */
	private _loadEntries(entries: FileEntry[]): void {
		const header = entries[0] as SessionHeader;
		if ((header.version ?? 1) < CURRENT_SESSION_VERSION) {
			throw new Error(
				`Session file version ${header.version ?? 1} is not supported (edupi reads version ${CURRENT_SESSION_VERSION})`,
			);
		}
		this.fileEntries = entries;
		this.sessionId = header.id;
		this._buildIndex();
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

	/** Writes every entry so far, replacing the file. */
	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		} finally {
			closeSync(fd);
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
		return this.fileEntries.some(
			(e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
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

	/**
	 * Appends a compaction summary. It also stores the current system message (the prompt and
	 * tools at this point), because the context rebuilt from it leaves out older system messages.
	 */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const base = this._entryBase();
		const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...base,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? base.id,
			tokensBefore,
			details,
			usage,
			fromHook,
			...(systemMessage
				? { systemMessage: { ...systemMessage, timestamp: new Date(base.timestamp).getTime() } }
				: {}),
		};
		this._appendEntry(entry as CompactionEntry);
		return entry.id;
	}

	/** Appends an edit of an earlier message entry's context; null leaves it out of the context. */
	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string {
		if (
			replacement !== null &&
			(typeof replacement !== "object" ||
				!("content" in replacement) ||
				(typeof replacement.content !== "string" && !Array.isArray(replacement.content)))
		) {
			throw new Error("Context edit replacement must be null or contain string/array content");
		}
		const target = this.byId.get(targetId);
		if (!target) throw new Error(`Entry ${targetId} not found`);
		if (!this.getBranch().some((entry) => entry.id === targetId)) {
			throw new Error(`Entry ${targetId} is not on the active branch`);
		}
		const editable =
			target.type === "message" &&
			(target.message.role === "user" ||
				target.message.role === "assistant" ||
				target.message.role === "toolResult");
		if (!editable) throw new Error(`Entry ${targetId} does not contribute editable model content`);
		// Assistant and tool result content is always blocks, so a string is stored as one text block.
		const normalizedReplacement =
			replacement !== null && target.message.role !== "user" && typeof replacement.content === "string"
				? { content: [{ type: "text" as const, text: replacement.content }] }
				: replacement;
		const entry: ContextEditEntry = {
			type: "context_edit",
			...this._entryBase(),
			targetId,
			replacement: normalizedReplacement,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/** The entries from the root to the leaf. */
	getBranch(): SessionEntry[] {
		return buildSessionPath(this.getEntries(), this.leafId);
	}

	buildSessionProjection(): SessionProjection {
		return buildSessionProjection(this.getEntries(), this.leafId);
	}

	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId);
	}

	getHeader(): SessionHeader | null {
		return this.fileEntries.find((e): e is SessionHeader => e.type === "session") ?? null;
	}

	/** All entries, without the header. */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
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
