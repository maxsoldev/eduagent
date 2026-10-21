// Mirrors pi packages/coding-agent/src/core/tools/path-utils.ts (pinned 16f5f0af4), resolveToCwd:
// the model's paths are relative to the working directory, or absolute, or start with ~. Some
// models put an @ in front of a path (a chat convention for files); pi drops it. A file:// URL is a path too.
// edupi leaves out pi's macOS file-name variants (NFD, curly quotes, AM/PM screenshot names).
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g; // pi utils/paths.ts

export function resolveToCwd(filePath: string, cwd: string): string {
	let path = filePath.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
