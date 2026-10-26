// What provider usage costs. Prices are USD per million tokens; images are a flat price each.

export interface TextUsage {
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

// Cache writes are the 5-minute TTL rate (1.25x input). A model missing here has an unknown cost.
export const LLM_PRICES: Record<string, TokenPrices> = {
  mock: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export const IMAGE_PRICE_USD = 0.04;

export function llmCost(model: string, u: TextUsage): number | null {
  const p = LLM_PRICES[model];

  if (!p) {
    return null;
  }

  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000;

  return Math.round(usd * 1_000_000) / 1_000_000;
}

// The shapes stored in operations.usage.
export function textUsage(model: string, u: TextUsage) {
  return { ...u, model, cost_usd: llmCost(model, u) };
}

export function imageUsage(model = 'mock') {
  return { images: 1, model, cost_usd: model === 'mock' ? IMAGE_PRICE_USD : null };
}
