import { FAULT_KINDS } from '@ryze/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { closeApps, HOST, inspect, JPEG, makeApp, registerSite, WP } from '../testing/helpers.js';

afterEach(closeApps);

const NO_FAULTS = { '429': 0, '500': 0, timeout: 0, slow: 0, complete_then_drop: 0 };

function as(app: FastifyInstance, token: string) {
  return (
    method: 'GET' | 'POST',
    url: string,
    payload?: object | Buffer,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, host: HOST, ...headers },
      payload,
    });
}

describe('WordPress authentication', () => {
  it('rejects missing and unknown credentials before any write', async () => {
    const app = makeApp();
    await registerSite(app, 'wp');

    for (const authorization of [undefined, 'Bearer nobody', 'Basic wp']) {
      const res = await app.inject({
        url: `${WP}/users/me`,
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }

    expect(
      (await as(app, 'unknown')('POST', `${WP}/posts`, { slug: 'hello-world' })).statusCode,
    ).toBe(401);
    expect((await inspect(app)).sites.flatMap((site) => site.posts)).toEqual([]);
    expect((await as(app, 'wp')('GET', `${WP}/users/me`)).statusCode).toBe(200);
  });

  it('accepts registered application-password credentials using Basic authentication', async () => {
    const app = makeApp();
    const credentials = 'editor:application password';
    await registerSite(app, credentials);
    const res = await app.inject({
      url: `${WP}/users/me`,
      headers: { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('admin', () => {
  it('uses default faults unless a registration overrides them', async () => {
    const app = makeApp({ faultRate: 0.2, faultKinds: ['429', 'slow'] });
    await registerSite(app, 'defaults');
    await registerSite(app, 'quiet', { rate: 0 });
    await registerSite(app, 'different', { kinds: ['500'] });
    expect((await inspect(app)).sites.map((site) => [site.token, site.faults])).toEqual([
      ['defaults', { rate: 0.2, kinds: ['429', 'slow'] }],
      ['quiet', { rate: 0, kinds: ['429', 'slow'] }],
      ['different', { rate: 0.2, kinds: ['500'] }],
    ]);
  });

  it('rejects malformed registrations and unsupported platforms', async () => {
    const app = makeApp();

    for (const payload of [
      {},
      { platform: 'wordpress' },
      { token: '', platform: 'wordpress' },
      { token: 'a' },
      { token: 'a', platform: 'shopify' },
      { token: 'a', platform: 'ghost' },
      { token: 'a', platform: 'wordpress', faults: { rate: 1.5 } },
      { token: 'a', platform: 'wordpress', faults: { rate: -0.1 } },
      { token: 'a', platform: 'wordpress', faults: { kinds: ['429', 'meteor'] } },
      { token: 'a', platform: 'wordpress', faults: 'often' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/_admin/sites', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    expect(await inspect(app)).toEqual({ sites: [] });
  });

  it('updates faults for a known token while preserving its posts', async () => {
    const app = makeApp();
    await registerSite(app, 'a', { rate: 0 });
    expect((await as(app, 'a')('POST', `${WP}/posts`, { slug: 'kept' })).statusCode).toBe(201);
    await registerSite(app, 'a', { rate: 1, kinds: ['500'] });
    expect((await as(app, 'a')('POST', `${WP}/posts`, { slug: 'other' })).statusCode).toBe(500);
    await registerSite(app, 'a', { rate: 0 });
    const [site] = (await inspect(app)).sites;
    expect(site.platform).toBe('wordpress');
    expect(site.faults).toEqual({ rate: 0, kinds: [...FAULT_KINDS] });
    expect(site.faults_injected['500']).toBe(1);
    expect(site.posts.map((post) => post.slug)).toEqual(['kept']);
  });

  it('inspects posts and media with the original publication URLs', async () => {
    const app = makeApp({ faultRate: 0, faultKinds: ['429'] });
    await registerSite(app, 'wp');
    const wp = as(app, 'wp');

    const headers = {
      'content-type': 'image/jpeg',
      'content-disposition': 'filename="ryze-a1.jpg"',
    };

    const media = (await wp('POST', `${WP}/media`, JPEG, headers)).json();

    const live = (
      await wp('POST', `${WP}/posts`, {
        slug: 'first-post',
        featured_media: media.id,
        meta: { ryze_article_id: 'a1' },
      })
    ).json();
    await wp('POST', `${WP}/posts/${live.id}`, { status: 'publish' });
    const draft = (await wp('POST', `${WP}/posts`, { slug: 'second-post' })).json();
    expect(await inspect(app)).toEqual({
      sites: [
        {
          token: 'wp',
          platform: 'wordpress',
          faults: { rate: 0, kinds: ['429'] },
          faults_injected: NO_FAULTS,
          media: [{ id: String(media.id), filename: 'ryze-a1.jpg' }],
          posts: [
            {
              id: String(live.id),
              slug: 'first-post',
              status: 'live',
              article_id: 'a1',
              media_id: String(media.id),
              url: `http://${HOST}/wordpress/blog/first-post`,
            },
            {
              id: String(draft.id),
              slug: 'second-post',
              status: 'draft',
              article_id: null,
              media_id: null,
              url: null,
            },
          ],
        },
      ],
    });
  });

  it('resets sites and their data', async () => {
    const app = makeApp();
    await registerSite(app, 'wp');
    await as(app, 'wp')('POST', `${WP}/posts`, { slug: 'hello-world' });
    const res = await app.inject({ method: 'POST', url: '/_admin/reset' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await inspect(app)).toEqual({ sites: [] });
    expect((await as(app, 'wp')('GET', `${WP}/users/me`)).statusCode).toBe(401);
  });

  it('answers the health check', async () => {
    const res = await makeApp().inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
