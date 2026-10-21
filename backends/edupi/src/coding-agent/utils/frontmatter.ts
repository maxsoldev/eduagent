// Mirrors pi packages/coding-agent/src/utils/frontmatter.ts (pinned 16f5f0af4): YAML frontmatter
// between a leading "---" line and the next "\n---", as in SKILL.md files.
import { parse } from "yaml";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
  frontmatter: T;
  body: string;
};

/** pi utils/text.ts: drop a leading byte order mark. */
export const stripBom = (content: string): string => (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
  const normalized = normalizeNewlines(stripBom(content));
  if (!normalized.startsWith("---")) return { yamlString: null, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { yamlString: null, body: normalized };
  return { yamlString: normalized.slice(4, endIndex), body: normalized.slice(endIndex + 4).trim() };
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(content: string): ParsedFrontmatter<T> => {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) return { frontmatter: {} as T, body };
  const parsed = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
