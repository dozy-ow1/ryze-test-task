import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { HttpError } from '../platforms/http.js';
import { Permanent } from '../quota.js';
import { ARTICLE_PROMPT, validateArticle } from './article-prompt.js';
import type { TextProvider } from './text.js';

const Article = z.object({
  title: z.string().describe('The headline: under 65 characters, the main keyword near the start'),
  body_html: z
    .string()
    .describe('The article as HTML: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>'),
  image_prompt: z.string().describe('One or two sentences describing the cover image to generate'),
});

export function createAnthropic(opts: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseURL?: string;
}): TextProvider {
  // Retries belong to the worker (it counts attempts and backs off), so the SDK makes none.
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: 0,
    timeout: opts.timeoutMs,
  });
  return {
    model: opts.model,
    async generate({ brief }, signal) {
      const res = await client.messages
        .parse(
          {
            model: opts.model,
            max_tokens: 4096,
            system: ARTICLE_PROMPT,
            messages: [{ role: 'user', content: `Brief: ${brief}` }],
            output_config: { effort: 'low', format: zodOutputFormat(Article) },
          },
          { signal },
        )
        .catch((err: unknown) => {
          throw toHttpError(err);
        });
      if (res.stop_reason === 'refusal') {
        throw new Permanent(
          `the model declined the brief (${res.stop_details?.category ?? 'refusal'})`,
        );
      }
      const out = res.parsed_output;
      if (!out) {
        throw new Error(`no article in the response (stop_reason ${res.stop_reason})`);
      }
      validateArticle(out);
      return {
        title: out.title,
        bodyHtml: out.body_html,
        imagePrompt: out.image_prompt,
        model: res.model,
        usage: {
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

// The SDK's typed errors onto the shared HttpError shape: 429 and 529/5xx stay retryable (and
// Retry-After is honored by the quota), 4xx is permanent, a connection failure or timeout is 0.
function toHttpError(err: unknown): unknown {
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(0, `anthropic: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const retryAfter = Number(err.headers?.get('retry-after'));
    return new HttpError(
      err.status,
      `anthropic: HTTP ${err.status} ${err.message}`.slice(0, 300),
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  return err;
}
