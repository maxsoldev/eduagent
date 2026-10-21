// Mirrors pi packages/coding-agent/src/utils/frontmatter.ts (pinned 16f5f0af4): YAML frontmatter
// between a leading "---" line and the next "\n---", as in SKILL.md files. edupi leaves out pi's
// byte order mark and CRLF handling.
import { parse } from "yaml";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	if (!content.startsWith("---")) return { yamlString: null, body: content };
	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) return { yamlString: null, body: content };
	return { yamlString: content.slice(4, endIndex), body: content.slice(endIndex + 4).trim() };
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) return { frontmatter: {} as T, body };
	return { frontmatter: (parse(yamlString) ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
