// edupi only: what each model request costs, in the shapes of educodex's observe/pricing.py, so
// the visualiser's cost panel reads both backends. pi already prices every response itself
// (ai/api/openai-completions.ts calculateCost, from Model.cost in USD per million tokens); this
// file only regroups pi's numbers. OpenRouter also reports what it billed (usage.cost).
import type { ModelCost, Usage } from "../ai/types.ts";

/** The `pricing` payload: pi's Model.cost under educodex's names. */
export function pricingJson(model: string, cost: ModelCost) {
  return {
    model,
    perMillionTokens: { prompt: cost.input, completion: cost.output, cache_read: cost.cacheRead, cache_write: cost.cacheWrite },
    longContext: null, // pi's Model.cost has one rate per kind
    longContextFromTokens: null,
  };
}

export interface CostBreakdown {
  tokens: { input: number; uncached: number; cached: number; cacheWrite: number; output: number; reasoning: number };
  cacheHitRate: number;
  billedUsd: number | null;
  usd?: { uncachedInput: number; cachedInput: number; cacheWrite: number; output: number; total: number; withoutCache: number; savedByCache: number };
}

const rate = (hits: number, total: number) => (total ? Math.round((hits / total) * 10000) / 10000 : 0);

/** One response's tokens and dollars. pi's usage.input is the uncached part of the prompt. */
export function costBreakdown(usage: Usage, cost: ModelCost | undefined, billedUsd: number | null): CostBreakdown {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const result: CostBreakdown = {
    tokens: { input, uncached: usage.input, cached: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, reasoning: usage.reasoning ?? 0 },
    cacheHitRate: rate(usage.cacheRead, input),
    billedUsd,
  };
  if (cost) {
    const withoutCache = (cost.input / 1e6) * input + (cost.output / 1e6) * usage.output; // the same request, no cache (pi's rounding order)
    result.usd = {
      uncachedInput: usage.cost.input, cachedInput: usage.cost.cacheRead, cacheWrite: usage.cost.cacheWrite, output: usage.cost.output,
      total: usage.cost.total, withoutCache, savedByCache: withoutCache - usage.cost.total,
    };
  }
  return result;
}

export interface CostTotal {
  tokens: CostBreakdown["tokens"];
  requests: number;
  cacheHitRate: number;
  usd?: NonNullable<CostBreakdown["usd"]>;
  billedUsd?: number;
}

/** Running sums over the process (all sessions), as educodex's add_totals. */
export function addTotals(total: CostTotal | undefined, last: CostBreakdown): CostTotal {
  const sum = <T extends object>(a: T | undefined, b: T): T =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, ((a as Record<string, number> | undefined)?.[k] ?? 0) + v])) as T;
  const tokens = sum(total?.tokens, last.tokens);
  const out: CostTotal = { tokens, requests: (total?.requests ?? 0) + 1, cacheHitRate: rate(tokens.cached, tokens.input) };
  if (last.usd) out.usd = sum(total?.usd, last.usd);
  else if (total?.usd) out.usd = total.usd;
  if (last.billedUsd !== null) out.billedUsd = (total?.billedUsd ?? 0) + last.billedUsd;
  else if (total?.billedUsd !== undefined) out.billedUsd = total.billedUsd;
  return out;
}
