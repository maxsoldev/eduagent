// Mirrors pi packages/coding-agent/src/core/tools/path-utils.ts (pinned 16f5f0af4), resolveToCwd:
// the model's paths are relative to the working directory, or absolute, or start with ~. Some
// models put an @ in front of a path (a chat convention for files); pi drops it.
// edupi leaves out pi's other path repairs (Unicode spaces, file:// URLs, macOS file-name variants).
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveToCwd(filePath: string, cwd: string): string {
	let path = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
