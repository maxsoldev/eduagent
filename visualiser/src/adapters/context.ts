// Helpers shared by the adapters' context() mappings (codex/context.ts, pi/context.ts).

/** A rough token count: 4 characters per token, of the text or of the JSON. */
export const approxTokens = (v: unknown) =>
	Math.ceil((typeof v === "string" ? v.length : JSON.stringify(v).length) / 4);

/** One line of at most 160 characters, for the context bar's tooltip. */
export const clip = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
};
