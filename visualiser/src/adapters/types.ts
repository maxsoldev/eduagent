// What the visualiser needs from an adapter. An adapter has two halves: a pure mapping from
// native messages to ViewActions (tested on recorded transcripts), and a client that sends
// commands in the native form. The UI talks only to this interface.
import type { ComponentType } from "react";
import type { CtxCat } from "../components/ContextBar";
import type { Capabilities, Capability } from "../view/capabilities";
import type { Explainer } from "../view/explain";
import type { Approval, Entry, Json, NativePart, ViewAction } from "../view/model";

export type SkillInfo = {
	name: string;
	description: string;
	shortDescription?: string | null;
	path: string;
	scope: string;
};
// needs: the capability this command depends on (hidden without it).
export type Command = { name: string; description: string; needs?: Capability };
export type Option = { value: string; label: string };
// model, effort and cwd are shared; adapters may keep more keys (Codex: approvalPolicy, sandbox).
export type Settings = { model: string; effort: string; cwd: string; [key: string]: string };

// The next model request, split into items for the Context tab and the context bar.
export type ContextItem = {
	label: string;
	cat: CtxCat;
	tokens: number;
	preview: string;
	summary: string;
	parts: { type: string; text?: string; tokens: number; raw: Json }[] | null;
	raw: Json;
};
export type ContextSnapshot = {
	items: ContextItem[];
	tools: { names: string[]; tokens: number };
	contextWindow: number;
	autoCompactLimit: number;
};

export type AdapterOptions = { url: string; capabilities: Capabilities; dispatch: (action: ViewAction) => void };

export interface Adapter {
	readonly explain: Explainer;
	readonly commands: Command[];
	readonly efforts: Option[];
	readonly protocolNote: string; // one line for the Protocol tab
	readonly contextTriggers: string[]; // trace event names after which the next request changed
	// Handshake; returns the models and the settings the backend chose.
	connect(): Promise<{ models: Option[] }>;
	startSession(settings: Settings): Promise<{ model?: string; cwd?: string }>; // what the backend chose
	send(settings: Settings, text: string, skills: { name: string; path: string }[]): Promise<void>;
	interrupt(): Promise<void>;
	// While a turn runs (capability "queues"): pi's steering and follow-up queues.
	steer?(text: string): Promise<void>;
	followUp?(text: string): Promise<void>;
	compact(customInstructions?: string): Promise<void>; // pi takes instructions for the summary; Codex has none
	listSkills(cwd: string): Promise<SkillInfo[]>;
	// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare returns (as in pi's extensions/types.ts)
	runCommand(name: string): Promise<string | void>; // adapter-only slash commands; returns a note
	setStepMode(enabled: boolean): Promise<void>;
	continueStep(): Promise<void>;
	context(): Promise<ContextSnapshot | null>;
	wireLabel(message: Json): { title: string; detail: string };
	respond(approval: Approval, result: Json): void;
}

// An adapter with its components for backend-only parts. NativeEntry draws every entry that has
// a `part`; the adapter sets `part` only where the generic chat would lose something.
export type AdapterModule = {
	protocol: string;
	create: (options: AdapterOptions) => Adapter;
	defaults: Partial<Settings>; // initial values of the adapter's own settings
	NativeEntry: ComponentType<{ entry: Entry; part: NativePart }>;
	ApprovalCard: ComponentType<{ approval: Approval; onAnswer: (result: Json) => void }>;
	Controls?: ComponentType<{
		settings: Settings;
		set: (key: string, value: string) => void;
		capabilities: Capabilities;
	}>;
};
