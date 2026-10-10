import { useState } from "react";
import type { Json } from "../rpc";

// A collapsible JSON tree. Long strings are clipped with a "more" toggle.
export function JsonView({ value, depth = 0, open = 1 }: { value: Json; depth?: number; open?: number }) {
  const [expanded, setExpanded] = useState(depth < open);
  if (value === null || typeof value !== "object") return <Scalar value={value} />;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [l, r] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return <span className="j-punct">{l + r}</span>;
  return (
    <span>
      <button className="j-toggle" onClick={() => setExpanded(!expanded)}>{expanded ? "▾" : "▸"}</button>
      <span className="j-punct">{l}</span>
      {!expanded && <span className="j-summary" onClick={() => setExpanded(true)}> {entries.length} {Array.isArray(value) ? "items" : "keys"} </span>}
      {expanded && (
        <div className="j-body">
          {entries.map(([k, v]) => (
            <div key={k}>
              {!Array.isArray(value) && <span className="j-key">{k}: </span>}
              <JsonView value={v} depth={depth + 1} open={open} />
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
