// The core is a clean port of pi: it never imports edupi's teaching extras (src/observe/) or the
// hosts that run it (RPC mode, main, the CLI). The extras plug in through hook points instead.
// Like educodex's backends/educodex/tests/test_layers.py.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");
const CORE = ["ai", "agent", "coding-agent/core"];
const FORBIDDEN = ["observe", "coding-agent/modes", "coding-agent/cli", "coding-agent/main.ts"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

/** Relative module specifiers in import/export statements and dynamic imports. */
function imports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  return [...code.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

test("the core does not import observe or the hosts", () => {
  const bad: string[] = [];
  for (const layer of CORE) {
    for (const file of tsFiles(join(SRC, layer))) {
      for (const spec of imports(file)) {
        const target = relative(SRC, resolve(dirname(file), spec));
        if (FORBIDDEN.some((f) => target === f || target.startsWith(`${f}/`))) bad.push(`${relative(SRC, file)}: ${spec}`);
      }
    }
  }
  expect(bad).toEqual([]);
});
