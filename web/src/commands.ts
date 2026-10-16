// Slash commands, in Codex's popup order (codex-rs/tui/src/slash_command.rs: "enum order is
// presentation order"). The descriptions of skills, new and compact are Codex's own. Codex has
// /memory-update and /memory-drop only as hidden debug stubs; here they run the memory pipeline.
export type Command = { name: string; description: string; needsMemories?: boolean };

export const COMMANDS: Command[] = [
  { name: "skills", description: "use skills to improve how Codex performs specific tasks" },
  { name: "new", description: "start a new chat during a conversation" },
  { name: "compact", description: "summarize conversation to prevent hitting the context limit" },
  { name: "memory-update", description: "learn from earlier threads now (memory phase 1 + phase 2)", needsMemories: true },
  { name: "memory-drop", description: "delete all memories" },
];

// Codex shows exact matches first, then prefix matches, each in presentation order (command_popup.rs).
export function matchCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return [...COMMANDS.filter((c) => c.name === q), ...COMMANDS.filter((c) => c.name !== q && c.name.startsWith(q))];
}

export type SkillInfo = { name: string; description: string; shortDescription?: string | null; path: string; scope: string };

// Fuzzy match: the query's letters appear in the name in order (Codex: codex-utils-fuzzy-match).
// Results keep the server's order (repo, user, system), with name-prefix matches first.
export function matchSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const q = query.toLowerCase();
  const fuzzy = (name: string) => { let i = 0; for (const ch of name.toLowerCase()) if (ch === q[i]) i++; return i === q.length; };
  const hits = skills.filter((s) => fuzzy(s.name));
  return [...hits.filter((s) => s.name.toLowerCase().startsWith(q)), ...hits.filter((s) => !s.name.toLowerCase().startsWith(q))];
}
