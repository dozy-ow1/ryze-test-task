import type { TextUsage } from '../pricing.js';

export interface TextResult {
  title: string;
  bodyHtml: string;
  imagePrompt: string;
  usage: TextUsage;
  model?: string; // the model that answered, when it may differ (a refusal fallback)
}

// Identical for the fake and the real provider. `model` names the price list entry.
export interface TextProvider {
  model: string;
  generate(input: { brief: string }, signal?: AbortSignal): Promise<TextResult>;
}
