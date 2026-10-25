import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Permanent } from '../utils/errors.js';
import { HttpError, retryAfterSeconds } from '../utils/http.js';
import { articleSchema, type TextProvider, validateArticle } from './text.js';

const ARTICLE_PROMPT = `Write a complete, accurate SEO article from the brief for a general audience.
Use plain, warm prose, a descriptive title under 65 characters and a 600–900 word body.
Introduce the topic, then use three to six useful sections and a short actionable conclusion.
Use the main keyword naturally. Never invent facts, studies, statistics, prices or quotes.
Return title, body_html and image_prompt. The body may contain only h2, h3, p, ul, ol, li,
strong and em tags, without attributes. No links, images, scripts, styles or title heading.
The image prompt should describe a landscape editorial photo or illustration without text,
logos, watermarks or recognizable real people.`;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseURL?: string;
}

export function createAnthropic(options: AnthropicOptions): TextProvider {
  // Retries belong to the worker (it counts attempts and backs off), so the SDK makes none.
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    timeout: options.timeoutMs,
  });

  return {
    model: options.model,

    async generate({ brief }, signal) {
      try {
        const res = await client.messages.create(
          {
            model: options.model,
            max_tokens: 4096,
            system: ARTICLE_PROMPT,
            messages: [{ role: 'user', content: `Brief: ${brief}` }],
            output_config: { effort: 'low', format: zodOutputFormat(articleSchema) },
          },
          { signal },
        );

        if (res.stop_reason === 'refusal') {
          throw new Permanent(
            `the model declined the brief (${res.stop_details?.category ?? 'refusal'})`,
          );
        }

        const text = res.content.find((block) => block.type === 'text')?.text;

        if (!text) {
          throw new Error(`no article in the response (stop_reason ${res.stop_reason})`);
        }

        const out = articleSchema.parse(JSON.parse(text));
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
      } catch (error) {
        signal?.throwIfAborted();

        throw toHttpError(error);
      }
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
    const retryAfter = retryAfterSeconds(err.headers?.get('retry-after') ?? undefined);

    return new HttpError(
      err.status,
      `anthropic: HTTP ${err.status} ${err.message}`.slice(0, 300),
      retryAfter,
    );
  }

  return err;
}
