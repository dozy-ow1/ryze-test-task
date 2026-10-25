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

// Prompt instructions are not a security boundary. Reject unsupported markup before publishing.
export function validateArticle(article: ArticleContent): void {
  if (!article.title.trim() || !article.body_html.trim() || !article.image_prompt.trim()) {
    throw new Permanent('generated article has empty fields');
  }

  const text = article.body_html.replace(/<\/?(?:h2|h3|p|ul|ol|li|strong|em)\s*>/gi, '');

  if (/[<>]/.test(text)) {
    throw new Permanent('generated article contains unsupported HTML');
  }
}
