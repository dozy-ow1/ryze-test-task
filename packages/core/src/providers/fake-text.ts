import { getJson, type Http } from '../platforms/http.js';
import type { TextUsage } from '../pricing.js';
import { validateArticle } from './article-prompt.js';
import type { TextProvider } from './text.js';

interface FakeText {
  title: string;
  body_html: string;
  image_prompt: string;
  usage: TextUsage;
}

// The emulator in packages/fake-providers.
export function createFakeText(http: Http, baseUrl: string): TextProvider {
  return {
    model: 'fake',
    async generate({ brief }, signal) {
      const r = await getJson<FakeText>(http, `${baseUrl}/v1/text`, {
        signal,
        method: 'POST',
        json: { brief },
      });
      validateArticle(r);
      return { title: r.title, bodyHtml: r.body_html, imagePrompt: r.image_prompt, usage: r.usage };
    },
  };
}
