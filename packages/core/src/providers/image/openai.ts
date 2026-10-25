import { getJson, type Http } from '../../adapters/http.js';
import type { ImageProvider } from '../image.js';

// OpenAI Images (gpt-image-1): synchronous, the image comes back base64 in the response. With a
// sync provider the pipeline has no image_submit step; image_fetch generates under the cover's
// S3 key, and its HEAD check is what prevents paying twice.
export function openaiImage(http: Http, opts: { apiKey: string; model: string }): ImageProvider {
  return {
    kind: 'sync',
    async generate(prompt) {
      const res = await getJson<{ data: { b64_json?: string }[] }>(
        http,
        'https://api.openai.com/v1/images/generations',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}` },
          json: { model: opts.model, prompt, size: '1536x1024', n: 1 },
        },
      );
      const b64 = res.data[0]?.b64_json;
      if (!b64) throw new Error('the image response carries no image');
      return Buffer.from(b64, 'base64');
    },
  };
}
