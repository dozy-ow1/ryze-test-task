import { SQL, textUsage, withQuota } from '@ryze/core';
import type { Clients } from '../clients.js';
import type { StepFn } from '../runner.js';

// What one article is expected to cost in LLM tokens: the unit the provider:llm bucket meters.
const ESTIMATED_TOKENS = 4000;

// Nothing to check first: if the worker dies between the answer and COMPLETE, the next attempt
// pays again. That window is accepted and counted by the demo.
export const text: StepFn<Clients> = async ({ article, clients, signal }) => {
  const out = await withQuota(clients.db, 'provider:llm', ESTIMATED_TOKENS, () => {
    signal.throwIfAborted();
    return clients.llm.generate({ brief: article.brief }, signal);
  });
  return {
    usage: textUsage(out.model ?? clients.llm.model, out.usage),
    write: {
      sql: SQL.WRITE_TEXT,
      params: [
        article.id,
        out.title,
        slugify(out.title, article.id),
        out.bodyHtml,
        out.imagePrompt,
      ],
    },
  };
};

// Lowercase ASCII, at most 80 characters, unique per site because it ends with the full article id.
export function slugify(title: string, articleId: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 43)
    .replace(/-+$/, '');
  return `${base || 'article'}-${articleId}`;
}
