import { getJson, type Http } from '../adapters/http.js';
import type { LlmUsage } from '../pricing.js';

export interface LlmResult {
  title: string;
  bodyHtml: string;
  imagePrompt: string;
  usage: LlmUsage;
  model?: string; // the model that answered, when it may differ (a refusal fallback)
}

// Identical for the fake and the real provider. `model` names the price list entry.
export interface LlmProvider {
  model: string;
  generate(input: { brief: string }): Promise<LlmResult>;
}

interface FakeText {
  title: string;
  body_html: string;
  image_prompt: string;
  usage: LlmUsage;
}

// The emulator in packages/fake-providers.
export function fakeLlm(http: Http, baseUrl: string): LlmProvider {
  return {
    model: 'fake',
    async generate({ brief }) {
      const r = await getJson<FakeText>(http, `${baseUrl}/v1/text`, {
        method: 'POST',
        json: { brief },
      });
      return { title: r.title, bodyHtml: r.body_html, imagePrompt: r.image_prompt, usage: r.usage };
    },
  };
}
