import { useEffect, useRef, useState } from "react";
import { matchCommands, matchSkills } from "../commands";
import type { Command, SkillInfo } from "../adapters/types";

// The message box. Typing "/" lists slash commands; typing "$" lists skills (as Codex's TUI does).
// A skill picked from the list is sent as a {type: "skill", name, path} input item next to the text.
// With queues (pi), the box stays open while a turn runs: Enter steers, Alt+Enter queues a follow-up.
type Popup =
  | { kind: "command"; items: Command[] }
  | { kind: "skill"; items: SkillInfo[]; start: number; end: number };

// commands: only those the backend's capabilities allow. loadSkills: null without the skills capability.
export function Composer({ disabled, turnRunning, placeholder, commands, loadSkills, onSend, onCommand, onInterrupt, queues }: {
  disabled: boolean; turnRunning: boolean; placeholder: string; commands: Command[];
  loadSkills: (() => Promise<SkillInfo[]>) | null;
  onSend: (text: string, skills: { type: "skill"; name: string; path: string }[]) => void;
  onCommand: (name: string, args?: string) => void; onInterrupt: () => void;
  queues?: { onSteer: (text: string) => void; onFollowUp: (text: string) => void } | null;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const picked = useRef(new Map<string, string>()); // skill name -> SKILL.md path
  const box = useRef<HTMLTextAreaElement>(null);

  const mention = loadSkills && /(^|\s)\$([A-Za-z0-9_:-]*)$/.exec(text.slice(0, caret));
  const popup: Popup | null = dismissed ? null
    : /^\/\S*$/.test(text) ? { kind: "command", items: matchCommands(commands, text.slice(1)) }
    : mention ? { kind: "skill", items: matchSkills(skills, mention[2]), start: caret - mention[2].length - 1, end: caret }
    : null;
  const open = popup && popup.items.length > 0 ? popup : null;

  // Scan the skills again each time a "$" mention starts, so new SKILL.md files show up.
  const mentionActive = Boolean(mention);
  useEffect(() => { if (mentionActive && loadSkills) loadSkills().then(setSkills).catch(() => setSkills([])); }, [mentionActive, loadSkills]);
  useEffect(() => setSelected(0), [open?.kind, open?.items.length]);

  const edit = (value: string, at: number) => { setText(value); setCaret(at); setDismissed(false); };
  const accept = (index: number) => {
    if (!open) return;
    if (open.kind === "command") { runCommand(open.items[index].name); return; }
    const skill = open.items[index];
    picked.current.set(skill.name, skill.path);
    const value = `${text.slice(0, open.start)}$${skill.name} ${text.slice(open.end)}`;
    const at = open.start + skill.name.length + 2;
    edit(value, at);
    requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
  };
  const runCommand = (name: string, args?: string) => { edit("", 0); onCommand(name, args); };
  const queue = (kind: "steer" | "followUp") => {
    if (!queues || !text.trim() || disabled) return;
    (kind === "steer" ? queues.onSteer : queues.onFollowUp)(text);
    edit("", 0);
  };
  const send = () => {
    if (turnRunning && queues) { queue("steer"); return; }
    // "/name" or "/name args": pi's /compact takes custom instructions after the name.
    const command = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
    if (command && matchCommands(commands, command[1])[0]?.name === command[1]) { runCommand(command[1], command[2]); return; }
    if (!text.trim() || disabled || turnRunning) return;
    // Only skills whose $name is still in the text; Codex drops mention bindings the same way.
    const skillItems = [...picked.current].filter(([name]) => text.includes(`$${name}`))
      .map(([name, path]) => ({ type: "skill" as const, name, path }));
    picked.current.clear();
    onSend(text, skillItems);
    edit("", 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      const n = open.items.length;
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((selected + 1) % n); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((selected - 1 + n) % n); return; }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
      if (e.key === "Tab" && open.kind === "command") { e.preventDefault(); edit(`/${open.items[selected].name}`, open.items[selected].name.length + 1); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); accept(selected); return; }
    }
    if (e.key === "Enter" && e.altKey && turnRunning && queues) { e.preventDefault(); queue("followUp"); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="composer">
      {open && (
        <div className="popup" data-testid={`${open.kind}-popup`} role="listbox">
          {open.items.map((item, i) => (
            <div key={item.name + ("path" in item ? item.path : "")} role="option" aria-selected={i === selected}
              className={`popup-row${i === selected ? " selected" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); accept(i); }} onMouseEnter={() => setSelected(i)}>
              <code className="popup-name">{open.kind === "command" ? "/" : "$"}{item.name}</code>
              <span className="popup-desc">{"shortDescription" in item ? item.shortDescription || item.description : item.description}</span>
              {"scope" in item && <span className="popup-tag">{item.scope}</span>}
            </div>
          ))}
          <div className="popup-hint">↑↓ select · Enter {open.kind === "command" ? "run" : "insert"} · Tab complete · Esc close</div>
        </div>
      )}
      <textarea ref={box} value={text} disabled={disabled} placeholder={placeholder} data-testid="composer"
        onChange={(e) => edit(e.target.value, e.target.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={onKeyDown} />
      {turnRunning && queues && <>
        <button className="primary" onClick={() => queue("steer")} disabled={disabled} title="goes in after the running tools, before the next model call (Enter)" data-testid="steer">steer</button>
        <button onClick={() => queue("followUp")} disabled={disabled} title="runs when the agent would stop (Alt+Enter)" data-testid="follow-up">follow-up</button>
      </>}
      {turnRunning
        ? <button className="danger" onClick={onInterrupt} data-testid="interrupt">{queues ? "abort" : "interrupt"}</button>
        : <button className="primary" onClick={send} disabled={disabled} data-testid="send">send</button>}
    </div>
  );
}
