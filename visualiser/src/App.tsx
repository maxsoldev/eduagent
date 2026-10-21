// One viewer: connects to one backend through its protocol's adapter and draws the neutral view.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Adapter, AdapterModule, Option, Settings } from "./adapters/types";
import { Chat } from "./components/Chat";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { pct, usd } from "./cost";
import { type BackendInfo, backendUrl } from "./launcher";
import { shows } from "./view/capabilities";
import { linksFor } from "./view/harness";
import { initialView, reduceView } from "./view/model";

export function App({ backend, cwd, module }: { backend: BackendInfo; cwd: string; module: AdapterModule }) {
	const [view, dispatch] = useReducer(reduceView, initialView);
	const caps = useMemo(() => new Set(backend.capabilities), [backend.capabilities]);
	const links = useMemo(() => linksFor(backend.harness), [backend.harness]);
	const adapterRef = useRef<Adapter | null>(null);
	const [models, setModels] = useState<Option[]>([]);
	const [settings, setSettings] = useState<Settings>({
		model: "",
		effort: "",
		cwd: "",
		...module.defaults,
	} as Settings);
	const [stepMode, setStepMode] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);

	const startSession = useCallback(
		async (s: Settings) => {
			const adapter = adapterRef.current!;
			const chosen = await adapter.startSession(s);
			setSettings((prev) => ({ ...prev, ...chosen }));
			if (stepMode) await adapter.setStepMode(true);
		},
		[stepMode],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: connect once; backend and cwd come from the URL
	useEffect(() => {
		const adapter = module.create({ url: backendUrl(backend.name, cwd), capabilities: caps, dispatch });
		adapterRef.current = adapter;
		(async () => {
			try {
				const { models } = await adapter.connect();
				setModels(models);
				await startSession(settings);
			} catch (err) {
				setConnectError(String((err as Error).message ?? err));
			}
		})();
	}, []);

	const note = (text: string, error = false) =>
		dispatch({ type: "notice", source: "visualiser", level: error ? "error" : "info", text });
	const adapter = adapterRef.current;
	const commands = (adapter?.commands ?? []).filter((c) => !c.needs || caps.has(c.needs));

	const send = async (text: string, skills: { name: string; path: string }[]) => {
		if (!view.sessionId || view.running) return;
		await adapter!.send(settings, text, skills).catch((err) => note(String(err.message ?? err), true));
	};

	// pi's queues: while a turn runs, a message steers the agent or waits as a follow-up.
	const queues =
		shows(caps, "queues") && adapter?.steer && adapter.followUp
			? {
					onSteer: (text: string) => adapter.steer!(text).catch((err) => note(String(err.message ?? err), true)),
					onFollowUp: (text: string) =>
						adapter.followUp!(text).catch((err) => note(String(err.message ?? err), true)),
				}
			: null;
	const queued = [
		...(view.queue?.steering ?? []).map((t) => ["steer", t]),
		...(view.queue?.followUp ?? []).map((t) => ["follow-up", t]),
	];

	const loadSkills = useCallback(() => adapterRef.current!.listSkills(settings.cwd), [settings.cwd]);

	// Slash commands from the composer. Like Codex, each maps to one backend request.
	const runCommand = async (name: string, args?: string) => {
		note(args ? `/${name} ${args}` : `/${name}`);
		try {
			if (name === "new") await startSession(settings);
			else if (name === "compact") await adapter!.compact(args);
			else if (name === "skills") {
				const skills = await loadSkills();
				note(
					skills.length
						? `Skills (type $ to use one):\n${skills.map((s) => `$${s.name} (${s.scope}): ${s.shortDescription || s.description}`).join("\n")}`
						: "No skills found. Add a folder with a SKILL.md to .agents/skills/ in your project.",
				);
			} else {
				const result = await adapter!.runCommand(name);
				if (result) note(result);
			}
		} catch (err) {
			note(String((err as Error).message ?? err), true);
		}
	};

	const toggleStep = async (enabled: boolean) => {
		setStepMode(enabled);
		await adapter?.setStepMode(enabled);
	};

	const set = (k: string, value: string) => setSettings({ ...settings, [k]: value });
	const ready = Boolean(view.sessionId);
	const closed = view.status === "closed" ? view.closedReason || `the connection to ${backend.name} closed` : null;

	return (
		<div className="app">
			<header>
				<div className="brand">
					<a href="/" title="pick another backend">
						<b data-testid="backend-name">{backend.name}</b>
					</a>{" "}
					<span className="muted">inside {backend.harness}</span>
				</div>
				<div className="controls">
					<select
						value={settings.model}
						onChange={(e) => set("model", e.target.value)}
						title="model"
						data-testid="model"
					>
						{models.map((m) => (
							<option key={m.value} value={m.value}>
								{m.label}
							</option>
						))}
					</select>
					{module.Controls && <module.Controls settings={settings} set={set} capabilities={caps} />}
					<select value={settings.effort} onChange={(e) => set("effort", e.target.value)} title="reasoning effort">
						<option value="">effort: default</option>
						{(adapter?.efforts ?? []).map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					{shows(caps, "stepMode") && (
						<label className="toggle" title="pause before each model call and tool call">
							<input
								type="checkbox"
								checked={stepMode}
								onChange={(e) => toggleStep(e.target.checked)}
								data-testid="step-mode"
							/>{" "}
							step mode
						</label>
					)}
					{shows(caps, "compact") && (
						<button
							type="button"
							onClick={() => adapter?.compact()}
							disabled={!ready || view.running}
							title="summarise history now"
							data-testid="compact"
						>
							compact
						</button>
					)}
					<button
						type="button"
						onClick={() => startSession(settings)}
						disabled={!ready || view.running}
						data-testid="new-thread"
					>
						new thread
					</button>
					{shows(caps, "costBadge") && view.costTotal && (
						<span
							className="cost-badge"
							data-testid="cost-badge"
							title={`${view.costTotal.requests} requests · ${view.costTotal.tokens.input.toLocaleString()} input tokens (${view.costTotal.tokens.cached.toLocaleString()} cached) · ${view.costTotal.tokens.output.toLocaleString()} output tokens${view.costTotal.usd ? ` · saved ${usd(view.costTotal.usd.savedByCache)} by caching` : ""}`}
						>
							{usd(view.costTotal.billedUsd ?? view.costTotal.usd?.total)} · {pct(view.costTotal.cacheHitRate)}{" "}
							cached
						</span>
					)}
					<span className={`conn ${view.status}`} data-testid="conn">
						{view.status}
					</span>
				</div>
			</header>
			{closed ? (
				<div className="banner" data-testid="backend-error">
					Backend stopped: {closed}. Reload the page to start a new {backend.name} process.
				</div>
			) : (
				connectError && (
					<div className="banner" data-testid="backend-error">
						Cannot start {backend.name}: {connectError}.
					</div>
				)
			)}
			<main>
				<section className="left">
					<div className="thread-info muted small">
						thread {view.sessionId?.slice(0, 8) ?? "—"} · cwd{" "}
						<input
							className="cwd"
							value={settings.cwd}
							onChange={(e) => set("cwd", e.target.value)}
							title="working directory (applies to new threads)"
						/>
					</div>
					<Chat
						turns={view.turns}
						approvals={shows(caps, "approvals") ? view.approvals : []}
						paused={view.paused}
						module={module}
						onAnswer={(a, result) => adapter?.respond(a, result)}
						onContinue={() => adapter?.continueStep()}
						welcome={[
							...(commands.length
								? [`Type / for commands (${commands.map((c) => `/${c.name}`).join(", ")}).`]
								: []),
							...(shows(caps, "skills") ? ["Type $ to use a skill."] : []),
							...(shows(caps, "stepMode") ? ["Turn on Step mode to pause before each model call."] : []),
						]}
					/>
					{queued.length > 0 && (
						<div className="queue" data-testid="queue">
							{queued.map(([kind, text], i) => (
								<div key={i} className="queued" data-testid="queued">
									<span className="badge">{kind}</span> {text}
								</div>
							))}
						</div>
					)}
					<Composer
						disabled={!ready}
						turnRunning={view.running}
						commands={commands}
						loadSkills={shows(caps, "skills") ? loadSkills : null}
						placeholder={
							!ready
								? "starting thread…"
								: view.running
									? queues
										? "agent is working… Enter steers, Alt+Enter queues a follow-up"
										: "agent is working…"
									: "Ask the agent to do something (/ for commands, $ for skills, Shift+Enter for newline)"
						}
						onSend={send}
						onCommand={runCommand}
						onInterrupt={() => adapter?.interrupt()}
						queues={queues}
					/>
				</section>
				<section className="right">
					<Inspector view={view} adapter={adapter} capabilities={caps} links={links} />
				</section>
			</main>
		</div>
	);
}
