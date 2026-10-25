import { createShopify } from '@ryze/core';
import { describe, expect, it } from 'vitest';
import { recordingHttp } from '../../../../test/support/http.js';

describe('shopify adapter against a real store', () => {
  const site = {
    id: 'site-1',
    platform: 'shopify' as const,
    base_url: 'https://test-store.myshopify.com/admin/api/2026-10/blogs/9',
    token: 'shpat_x',
  };
  const root = '/admin/api/2026-10';

  it('sends the cover inline, follows the call limit and builds the public URL', async () => {
    const limits: number[] = [];
    const { http, calls } = recordingHttp({
      [`GET ${root}/blogs/9/articles.json?handle=keep-basil-alive-1`]: () => ({
        body: { articles: [] },
      }),
      [`POST ${root}/blogs/9/articles.json`]: () => ({
        headers: { 'x-shopify-shop-api-call-limit': '32/40' },
        body: { article: { id: 55, handle: 'keep-basil-alive-1', published_at: null } },
      }),
      [`PUT ${root}/blogs/9/articles/55.json`]: () => ({
        body: { article: { id: 55, handle: 'keep-basil-alive-1', published_at: '2026-10-25' } },
      }),
      [`GET ${root}/shop.json`]: () => ({ body: { shop: { domain: 'shop.example.com' } } }),
      [`GET ${root}/blogs/9.json`]: () => ({ body: { blog: { handle: 'news' } } }),
    });
    const adapter = createShopify(http, async (_site, available) => {
      limits.push(available);
    });

    expect(await adapter.findMedia(site, 'ryze-1.jpg')).toBeNull();
    expect(await adapter.uploadMedia(site, 'ryze-1.jpg', Buffer.from('cover'))).toBe('ryze-1.jpg');
    expect(calls).toHaveLength(0); // a real store has no media library to call

    expect(await adapter.findBySlug(site, 'keep-basil-alive-1')).toBeNull();
    const id = await adapter.createDraft(site, {
      title: 'Keep Basil Alive',
      slug: 'keep-basil-alive-1',
      bodyHtml: '<p>x</p>',
      mediaId: 'ryze-1.jpg',
      articleId: 'a-1',
      image: async () => Buffer.from('cover'),
    });
    expect(id).toBe('55');
    const created = calls.find((c) => c.key.startsWith('POST'))?.req;
    expect(created?.headers?.['x-shopify-access-token']).toBe('shpat_x');
    expect(created?.json).toMatchObject({
      article: {
        published: false,
        image: { attachment: Buffer.from('cover').toString('base64'), filename: 'ryze-1.jpg' },
        metafields: [{ namespace: 'ryze', key: 'article_id', value: 'a-1' }],
      },
    });
    expect(limits).toEqual([8]);
    expect(await adapter.publish(site, '55')).toBe(
      'https://shop.example.com/blogs/news/keep-basil-alive-1',
    );
  });
});

describe('Shopify effect recovery', () => {
  const site = {
    id: 'site',
    platform: 'shopify' as const,
    base_url: 'https://store.myshopify.com/admin/api/2026-10/blogs/1',
    token: 'secret',
  };
  const input = {
    title: 'Title',
    slug: 'title-id',
    bodyHtml: '<p>Body</p>',
    mediaId: 'cover.jpg',
    articleId: 'id',
    image: async () => Buffer.from('cover'),
  };

  it('preserves a successful write when quota bookkeeping fails', async () => {
    const { http, calls } = recordingHttp({
      'POST /admin/api/2026-10/blogs/1/articles.json': () => ({
        headers: { 'x-shopify-shop-api-call-limit': '1/40' },
        body: { article: { id: 42 } },
      }),
    });
    const adapter = createShopify(http, async () => {
      throw new Error('database unavailable');
    });
    expect(await adapter.createDraft(site, input)).toBe('42');
    expect(calls).toHaveLength(1);
  });

  it('does not create a draft after losing the lease while loading its image', async () => {
    const { http, calls } = recordingHttp({});
    const controller = new AbortController();
    const image = async () => {
      controller.abort(new Error('lease lost'));
      return Buffer.from('cover');
    };
    await expect(
      createShopify(http).createDraft(site, { ...input, image }, controller.signal),
    ).rejects.toThrow('lease lost');
    expect(calls).toHaveLength(0);
  });
});
