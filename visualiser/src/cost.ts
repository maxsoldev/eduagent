// Money and cache helpers for the UI. Costs come from trace/cost (server-side observe/pricing.py);
// per-item numbers in the Context tab are estimates spread over items by their size.
import type { Json } from "./rpc";

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n === 0) return "$0";
  if (n < 0.000001) return "<$0.000001";
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export type CacheStatus = "cached" | "partly cached" | "uncached" | "new";

// Which items of the next request were read from the cache by the last request?
// The cache covers a prefix (tools first, then input items), so walk items in order until the
// cached token count is used up. Estimated sizes are scaled to the real token count.
export function cacheStatus(itemTokens: number[], toolsTokens: number, last: Json | null): {
  status: CacheStatus[]; scale: number; sentItems: number;
} {
  if (!last) return { status: itemTokens.map(() => "new"), scale: 1, sentItems: 0 };
  const sentItems = Math.min(last.inputItems ?? 0, itemTokens.length);
  const estimated = toolsTokens + itemTokens.slice(0, sentItems).reduce((a, b) => a + b, 0);
  const scale = estimated ? last.last.tokens.input / estimated : 1;
  const cachedEst = last.last.tokens.cached / scale;
  let cum = toolsTokens;
  const status = itemTokens.map((t, i): CacheStatus => {
    if (i >= sentItems) return "new";
    const start = cum;
    cum += t;
    return cum <= cachedEst ? "cached" : start < cachedEst ? "partly cached" : "uncached";
  });
  return { status, scale, sentItems };
}

// Expected input cost of one item in the *next* request: items sent before should be cache hits,
// new items get written to the cache.
export function nextRequestCost(tokens: number, status: CacheStatus, pricing: Json | null): number | null {
  if (!pricing) return null;
  const rate = pricing.perMillionTokens;
  const perToken = (status === "new" ? rate.cache_write : rate.cache_read) / 1e6;
  return tokens * perToken;
}

export function uncachedCost(tokens: number, pricing: Json | null): number | null {
  return pricing ? (tokens * pricing.perMillionTokens.prompt) / 1e6 : null;
}
