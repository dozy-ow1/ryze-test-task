import { createWordPress, HttpError } from '@ryze/core';
import { describe, expect, it } from 'vitest';
import { recordingHttp } from '../../testing/http.js';

describe('wordpress adapter against a real site', () => {
  const site = {
    id: 'site-2',
    platform: 'wordpress' as const,
    base_url: 'https://blog.example.com/wp-json',
    token: 'editor:abcd efgh',
  };

  it('uses Application Passwords and drops an unregistered meta field', async () => {
    let attempts = 0;

    const { http, calls } = recordingHttp({
      'POST /wp-json/wp/v2/posts': (req) => {
        attempts++;

        if ((req.json as { meta?: unknown }).meta) {
          throw new HttpError(
            400,
            'POST /wp-json/wp/v2/posts: HTTP 400 {"code":"rest_invalid_param","message":"Invalid parameter(s): meta"}',
          );
        }

        return { body: { id: 77, status: 'draft', link: 'https://blog.example.com/?p=77' } };
      },
    });

    const id = await createWordPress(http).createDraft(site, {
      title: 't',
      slug: 's',
      bodyHtml: '<p>x</p>',
      mediaId: '12',
      articleId: 'a-2',
    });
    expect(id).toBe('77');
    expect(attempts).toBe(2);
    expect(calls[0].req.headers?.authorization).toBe(
      `Basic ${Buffer.from('editor:abcd efgh').toString('base64')}`,
    );
  });
});
