import { createOpenAI } from '@ryze/shared';
import { describe, expect, it } from 'vitest';
import { recordingHttp } from '../testing/http.js';

describe('openai image provider', () => {
  it('is synchronous and returns the decoded image', async () => {
    const { http, calls } = recordingHttp({
      'POST /v1/images/generations': () => ({
        body: { data: [{ b64_json: Buffer.from('png bytes').toString('base64') }] },
      }),
    });

    const image = createOpenAI(http, { apiKey: 'sk-o', model: 'gpt-image-1' });
    expect(image.kind).toBe('sync');
    expect((await image.generate?.('basil'))?.toString()).toBe('png bytes');
    expect(calls[0].req.headers?.authorization).toBe('Bearer sk-o');
    expect(calls[0].req.json).toMatchObject({ model: 'gpt-image-1', prompt: 'basil' });
  });
});
