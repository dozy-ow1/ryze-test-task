import { getJson, type Http } from '../utils/http.js';
import type { TextUsage } from './pricing.js';
import { type ArticleContent, sanitizeArticle, type TextProvider } from './text.js';

type MockText = ArticleContent & { usage: TextUsage };

// The emulator in apps/mock-providers.
export function createMockText(http: Http, baseUrl: string): TextProvider {
  return {
    model: 'mock',

    async generate({ brief }, signal) {
      const r = await getJson<MockText>(http, `${baseUrl}/v1/text`, {
        signal,
        method: 'POST',
        json: { brief },
      });

      const out = sanitizeArticle(r);

      return {
        title: out.title,
        bodyHtml: out.body_html,
        imagePrompt: out.image_prompt,
        usage: r.usage,
      };
    },
  };
}
