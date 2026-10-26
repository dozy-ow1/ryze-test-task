import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import { Permanent } from '../utils/errors.js';
import type { TextUsage } from './pricing.js';

export interface TextResult {
  title: string;
  bodyHtml: string;
  imagePrompt: string;
  usage: TextUsage;
  model?: string; // The model reported by the provider.
}

// Identical for the mock and the real provider. `model` names the price list entry.
export interface TextProvider {
  model: string;
  generate(input: { brief: string }, signal?: AbortSignal): Promise<TextResult>;
}

export const articleSchema = z.object({
  title: z.string().describe('Headline under 65 characters'),
  body_html: z
    .string()
    .describe('HTML using h2, h3, p, ul, ol, li, strong and em tags without attributes'),
  image_prompt: z.string().describe('One or two sentences describing the cover image'),
});

export type ArticleContent = z.infer<typeof articleSchema>;

// Normalize provider output with a parser-backed allowlist before it reaches a publishing API.
export function sanitizeArticle(article: ArticleContent): ArticleContent {
  const bodyHtml = sanitizeHtml(article.body_html, {
    allowedTags: ['h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'em'],
    allowedAttributes: {},
  });

  const visibleText = sanitizeHtml(bodyHtml, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .trim();

  if (!article.title.trim() || !visibleText || !article.image_prompt.trim()) {
    throw new Permanent('generated article has empty fields');
  }

  return { ...article, body_html: bodyHtml };
}
