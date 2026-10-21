// Matching for the composer popups. The command list comes from the adapter (adapters/*/client.ts).
import type { Command, SkillInfo } from "./adapters/types";

// Codex shows exact matches first, then prefix matches, each in presentation order (command_popup.rs).
export function matchCommands(commands: Command[], query: string): Command[] {
	const q = query.toLowerCase();
	return [...commands.filter((c) => c.name === q), ...commands.filter((c) => c.name !== q && c.name.startsWith(q))];
}

// Fuzzy match: the query's letters appear in the name in order (Codex: codex-utils-fuzzy-match).
// Results keep the server's order (repo, user, system), with name-prefix matches first.
export function matchSkills(skills: SkillInfo[], query: string): SkillInfo[] {
	const q = query.toLowerCase();
	const fuzzy = (name: string) => {
		let i = 0;
		for (const ch of name.toLowerCase()) if (ch === q[i]) i++;
		return i === q.length;
	};
	const hits = skills.filter((s) => fuzzy(s.name));
	return [
		...hits.filter((s) => s.name.toLowerCase().startsWith(q)),
		...hits.filter((s) => !s.name.toLowerCase().startsWith(q)),
	];
}
