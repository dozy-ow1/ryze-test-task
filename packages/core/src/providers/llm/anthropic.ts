import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { HttpError } from '../../adapters/http.js';
import { Permanent } from '../../quota.js';
import type { LlmProvider } from '../llm.js';

const Article = z.object({
  title: z.string().describe('The headline: under 65 characters, the main keyword near the start'),
  body_html: z
    .string()
    .describe('The article as HTML: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>'),
  image_prompt: z.string().describe('One or two sentences describing the cover image to generate'),
});

// The static part of every request. It is the cached prefix (cache_control on this block), so it
// must stay byte-identical across calls and long enough to be cacheable (at least 512 tokens on
// Claude Sonnet 5.5). The brief goes in the user message, after the breakpoint.
const SYSTEM = `You are a senior SEO content writer for the blogs of small and mid-sized businesses. You turn a short brief into one complete, publish-ready article. The article goes live without an editor, so it must be accurate, specific and finished.

Audience and voice
- Write for a curious non-expert who found the article through search and wants a practical answer.
- Use a warm, confident, plain voice. Prefer short sentences and concrete examples over abstractions.
- Address the reader as "you". Avoid hype, clichés and filler such as "in today's fast-paced world".
- Never invent statistics, studies, prices, quotes, product names or people. When a number would help and you are not certain of it, describe the idea qualitatively instead.

Structure
- 600 to 900 words in the body.
- Open with one or two short paragraphs that state the problem and promise what the reader will learn. Do not start with a heading.
- Then three to six sections, each with an <h2> heading phrased the way people search (a question or a clear task). Use <h3> only when a section genuinely has sub-parts.
- Use a list (<ul> or <ol>) where steps or options are naturally listy, at most two lists in the article.
- End with a short closing section that summarizes the key takeaway and suggests one next step.

SEO
- Identify the primary keyword from the brief. Use it in the title, in the first paragraph and in one <h2>, naturally; never stuff it.
- Use two or three closely related phrases where they fit the meaning.
- The title is under 65 characters, specific, and promises a clear benefit; no clickbait, no year unless the brief asks for one.

HTML rules
- body_html contains only these tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>. No <h1> (the title is rendered separately), no inline styles, no classes, no images, no links, no scripts.
- Every paragraph is wrapped in <p>. Do not include the title inside body_html.

Cover image
- image_prompt describes one editorial photograph or illustration that fits the article: subject, setting, mood and composition, landscape orientation.
- No text, letters, logos, watermarks, brand names or recognizable real people in the image.

If the brief is unclear, choose the most useful reasonable interpretation for a general audience rather than asking questions. Return only the structured fields.`;

export function anthropicLlm(opts: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseURL?: string;
}): LlmProvider {
  // Retries belong to the worker (it counts attempts and backs off), so the SDK makes none.
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: 0,
    timeout: opts.timeoutMs,
  });
  return {
    model: opts.model,
    async generate({ brief }) {
      const res = await client.beta.messages
        .parse({
          model: opts.model,
          max_tokens: 4096,
          // If the model declines a brief for policy reasons, the API retries it on its default
          // fallback model inside the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: `Brief: ${brief}` }],
          output_config: { effort: 'low', format: betaZodOutputFormat(Article) },
        })
        .catch((err: unknown) => {
          throw toHttpError(err);
        });
      if (res.stop_reason === 'refusal') {
        throw new Permanent(
          `the model declined the brief (${res.stop_details?.category ?? 'refusal'})`,
        );
      }
      const out = res.parsed_output;
      if (!out) throw new Error(`no article in the response (stop_reason ${res.stop_reason})`);
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
  if (err instanceof Anthropic.APIConnectionError)
    return new HttpError(0, `anthropic: ${err.message}`);
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
