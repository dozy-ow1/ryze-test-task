// What provider usage costs. Prices are USD per million tokens; images are a flat price each.

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const LLM_PRICES: Record<string, TokenPrices> = {
  fake: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

export const IMAGE_PRICE_USD = 0.04;

export function llmCost(model: string, u: LlmUsage): number {
  const p = LLM_PRICES[model] ?? LLM_PRICES.fake;
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// The shapes stored in operations.usage.
export function textUsage(model: string, u: LlmUsage) {
  return { ...u, cost_usd: llmCost(model, u) };
}

export function imageUsage() {
  return { images: 1, cost_usd: IMAGE_PRICE_USD };
}
