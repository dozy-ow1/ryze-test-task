import { FAULT_KINDS } from '@ryze/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeApps,
  HOST,
  inspect,
  JPEG,
  makeApp,
  registerSite,
  SHOP,
  WP,
} from '../../../test/support/platforms.js';

afterEach(closeApps);

const NO_FAULTS = { '429': 0, '500': 0, timeout: 0, slow: 0, complete_then_drop: 0 };

function as(app: FastifyInstance, token: string) {
  return (
    method: 'GET' | 'POST' | 'PUT',
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

describe('auth', () => {
  it('answers 401 without a bearer token, for unknown tokens and for the other platform', async () => {
    const app = makeApp();
    await registerSite(app, 'wp', 'wordpress');
    await registerSite(app, 'shop', 'shopify');

    const refused: [string, string | undefined][] = [
      [`${WP}/users/me`, undefined],
      [`${WP}/users/me`, 'Bearer nobody'],
      [`${WP}/users/me`, 'Bearer shop'],
      [`${WP}/users/me`, 'Basic wp'],
      [`${SHOP}/shop.json`, undefined],
      [`${SHOP}/shop.json`, 'Bearer nobody'],
      [`${SHOP}/shop.json`, 'Bearer wp'],
    ];
    for (const [url, authorization] of refused) {
      const res = await app.inject({ url, headers: authorization ? { authorization } : {} });
      expect(res.statusCode, `${url} with ${authorization}`).toBe(401);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }

    const write = await as(app, 'shop')('POST', `${WP}/posts`, { slug: 'hello-world' });
    expect(write.statusCode).toBe(401);
    expect((await inspect(app)).sites.flatMap((s) => s.posts)).toEqual([]);

    expect((await as(app, 'wp')('GET', `${WP}/users/me`)).statusCode).toBe(200);
    expect((await as(app, 'shop')('GET', `${SHOP}/shop.json`)).statusCode).toBe(200);
  });
});

describe('admin', () => {
  it('registers a site with the default faults unless it brings its own', async () => {
    const app = makeApp({ faultRate: 0.2, faultKinds: ['429', 'slow'] });
    const register = (payload: object) =>
      app.inject({ method: 'POST', url: '/_admin/sites', payload });

    const plain = await register({ token: 'a', platform: 'wordpress' });
    expect(plain.statusCode).toBe(201);
    expect(plain.json()).toEqual({
      token: 'a',
      platform: 'wordpress',
      faults: { rate: 0.2, kinds: ['429', 'slow'] },
    });

    const own = await register({ token: 'b', platform: 'shopify', faults: { rate: 0 } });
    expect(own.json()).toEqual({
      token: 'b',
      platform: 'shopify',
      faults: { rate: 0, kinds: ['429', 'slow'] },
    });

    const kinds = await register({ token: 'c', platform: 'shopify', faults: { kinds: ['500'] } });
    expect(kinds.json().faults).toEqual({ rate: 0.2, kinds: ['500'] });
  });

  it('rejects malformed registrations', async () => {
    const app = makeApp();
    for (const payload of [
      {},
      { platform: 'wordpress' },
      { token: '', platform: 'wordpress' },
      { token: 'a' },
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

  it('re-registering a token updates its platform and faults and keeps its data', async () => {
    const app = makeApp();
    await registerSite(app, 'a', 'wordpress', { rate: 0 });
    expect((await as(app, 'a')('POST', `${WP}/posts`, { slug: 'kept' })).statusCode).toBe(201);

    await registerSite(app, 'a', 'wordpress', { rate: 1, kinds: ['500'] });
    expect((await as(app, 'a')('POST', `${WP}/posts`, { slug: 'other' })).statusCode).toBe(500);

    await registerSite(app, 'a', 'shopify', { rate: 0 });
    expect((await as(app, 'a')('GET', `${WP}/users/me`)).statusCode).toBe(401);

    const [site] = (await inspect(app)).sites;
    expect(site.platform).toBe('shopify');
    expect(site.faults).toEqual({ rate: 0, kinds: [...FAULT_KINDS] });
    expect(site.faults_injected['500']).toBe(1);
    expect(site.posts.map((p) => p.slug)).toEqual(['kept']);
  });

  it('inspect reports both platforms in one normalized shape', async () => {
    const app = makeApp({ faultRate: 0, faultKinds: ['429'] });
    await registerSite(app, 'wp', 'wordpress');
    await registerSite(app, 'shop', 'shopify');
    const wp = as(app, 'wp');
    const shop = as(app, 'shop');

    const image = { 'content-type': 'image/jpeg', 'content-disposition': 'filename="ryze-a1.jpg"' };
    const wpMedia = (await wp('POST', `${WP}/media`, JPEG, image)).json();
    const wpLive = (
      await wp('POST', `${WP}/posts`, {
        slug: 'first-post',
        featured_media: wpMedia.id,
        meta: { ryze_article_id: 'a1' },
      })
    ).json();
    await wp('POST', `${WP}/posts/${wpLive.id}`, { status: 'publish' });
    const wpDraft = (await wp('POST', `${WP}/posts`, { slug: 'second-post' })).json();

    const upload = { filename: 'ryze-b1.jpg', attachment: JPEG.toString('base64') };
    const shopMedia = (await shop('POST', `${SHOP}/media.json`, upload)).json().media;
    const shopDraft = (
      await shop('POST', `${SHOP}/blogs/1/articles.json`, {
        article: {
          handle: 'third-post',
          image: { media_id: shopMedia.id },
          metafields: [{ namespace: 'ryze', key: 'article_id', value: 'b1' }],
        },
      })
    ).json().article;
    const shopLive = (
      await shop('POST', `${SHOP}/blogs/1/articles.json`, {
        article: { handle: 'fourth-post', published: true },
      })
    ).json().article;

    // inspect() itself asks with another Host: the URLs are those given at publish time.
    expect(await inspect(app)).toEqual({
      sites: [
        {
          token: 'wp',
          platform: 'wordpress',
          faults: { rate: 0, kinds: ['429'] },
          faults_injected: NO_FAULTS,
          media: [{ id: String(wpMedia.id), filename: 'ryze-a1.jpg' }],
          posts: [
            {
              id: String(wpLive.id),
              slug: 'first-post',
              status: 'live',
              article_id: 'a1',
              media_id: String(wpMedia.id),
              url: `http://${HOST}/wordpress/blog/first-post`,
            },
            {
              id: String(wpDraft.id),
              slug: 'second-post',
              status: 'draft',
              article_id: null,
              media_id: null,
              url: null,
            },
          ],
        },
        {
          token: 'shop',
          platform: 'shopify',
          faults: { rate: 0, kinds: ['429'] },
          faults_injected: NO_FAULTS,
          media: [{ id: String(shopMedia.id), filename: 'ryze-b1.jpg' }],
          posts: [
            {
              id: String(shopDraft.id),
              slug: 'third-post',
              status: 'draft',
              article_id: 'b1',
              media_id: String(shopMedia.id),
              url: null,
            },
            {
              id: String(shopLive.id),
              slug: 'fourth-post',
              status: 'live',
              article_id: null,
              media_id: null,
              url: `http://${HOST}/shopify/blogs/news/fourth-post`,
            },
          ],
        },
      ],
    });
  });

  it('reset forgets every site and its data', async () => {
    const app = makeApp();
    await registerSite(app, 'wp', 'wordpress');
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
