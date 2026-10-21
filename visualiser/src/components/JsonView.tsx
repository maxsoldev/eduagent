import { useState } from "react";
import type { Json } from "../view/model";

// A collapsible JSON tree. The arrow expands a node and everything below it; clicking the key
// or the "N items" summary opens just one level. Long strings are clipped with a "more" toggle.
export function JsonView({ value, depth = 0, open = 1, label, all = false }:
  { value: Json; depth?: number; open?: number; label?: string; all?: boolean }) {
  const [expanded, setExpanded] = useState(all || depth < open);
  const [deep, setDeep] = useState(all); // children start expanded too
  const key = label !== undefined && <span className="j-key">{label}: </span>;
  if (value === null || typeof value !== "object") return <>{key}<Scalar value={value} /></>;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [l, r] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return <>{key}<span className="j-punct">{l + r}</span></>;
  const toggle = (recursive: boolean) => { setDeep(recursive && !expanded); setExpanded(!expanded); };
  return (
    <span>
      {label !== undefined && <span className="j-key clickable" onClick={() => toggle(false)}>{label}: </span>}
      <button className="j-toggle" onClick={() => toggle(true)} title={expanded ? "collapse" : "expand all below"}>{expanded ? "▾" : "▸"}</button>
      <span className="j-punct">{l}</span>
      {!expanded && <span className="j-summary" onClick={() => toggle(false)}> {entries.length} {Array.isArray(value) ? "items" : "keys"} </span>}
      {expanded && (
        <div className="j-body">
          {entries.map(([k, v]) => (
            <div key={k}>
              <JsonView value={v} depth={depth + 1} open={open} all={deep} label={Array.isArray(value) ? undefined : k} />
            </div>
          ))}
        </div>
      )}
      <span className="j-punct">{r}</span>
    </span>
  );
}

function Scalar({ value }: { value: Json }) {
  const [full, setFull] = useState(false);
  if (typeof value === "string") {
    const clip = value.length > 400 && !full;
    return (
      <span className="j-str">
        "{clip ? value.slice(0, 400) : value}"
        {value.length > 400 && <button className="j-more" onClick={() => setFull(!full)}>{full ? "less" : `+${value.length - 400} chars`}</button>}
      </span>
    );
  }
  return <span className={`j-${typeof value}`}>{String(value)}</span>;
}
