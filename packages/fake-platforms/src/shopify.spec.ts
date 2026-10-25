import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeApps,
  HOST,
  JPEG,
  makeApp,
  registerSite,
  SHOP,
} from '../../../test/support/platforms.js';

const ARTICLE = '5c9d0e1f-2a3b-4c5d-8e6f-7a8b9c0d1e2f';
const FILE = `ryze-${ARTICLE}.jpg`;
const BLOG = '/blogs/1';

let app: FastifyInstance;

beforeEach(async () => {
  app = makeApp();
  await registerSite(app, 'shop-token', 'shopify');
});
afterEach(closeApps);

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `${SHOP}${path}`,
    headers: { authorization: 'Bearer shop-token', host: HOST },
    payload,
  });
}

function upload(filename = FILE, attachment = JPEG.toString('base64')) {
  return call('POST', '/media.json', { filename, attachment });
}

function createDraft(handle: string, mediaId?: number) {
  return call('POST', `${BLOG}/articles.json`, {
    article: {
      title: 'Hello',
      handle,
      body_html: '<p>Hi</p>',
      published: false,
      image: mediaId === undefined ? undefined : { media_id: mediaId },
      metafields: [{ namespace: 'ryze', key: 'article_id', value: ARTICLE }],
    },
  });
}

describe('Shopify', () => {
  it('answers the verify call', async () => {
    const res = await call('GET', '/shop.json');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ shop: { id: 1, name: 'Ryze Demo Shop' } });
  });

  it('uploads base64 media and finds it by exact file name', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const { media } = res.json();
    expect(media).toEqual({ id: expect.any(Number), filename: FILE });

    expect((await call('GET', `/media.json?filename=${FILE}`)).json()).toEqual({ media: [media] });
    expect((await call('GET', `/media.json?filename=ryze-${ARTICLE}`)).json()).toEqual({
      media: [],
    });
  });

  it('stores a repeated file name as another item', async () => {
    const first = (await upload()).json().media;
    const second = (await upload()).json().media;
    expect(second.id).not.toBe(first.id);
    expect((await call('GET', `/media.json?filename=${FILE}`)).json()).toEqual({
      media: [first, second],
    });
  });

  it('rejects media without a file name or attachment', async () => {
    expect((await call('POST', '/media.json', { attachment: 'AAAA' })).statusCode).toBe(400);
    expect((await call('POST', '/media.json', { filename: FILE })).statusCode).toBe(400);
    expect((await upload(FILE, '')).statusCode).toBe(400);
  });

  it('accepts base64 attachments above the default 1 MB body limit', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');
    expect((await upload(FILE, big)).statusCode).toBe(201);
  });

  it('creates a hidden article once per handle and finds it by handle and by id', async () => {
    const media = (await upload()).json().media;
    const res = await createDraft('hello-world', media.id);
    expect(res.statusCode).toBe(201);
    const { article } = res.json();
    expect(article).toEqual({
      id: expect.any(Number),
      title: 'Hello',
      handle: 'hello-world',
      body_html: '<p>Hi</p>',
      published: false,
      url: null,
      image: { media_id: media.id },
      metafields: [{ namespace: 'ryze', key: 'article_id', value: ARTICLE }],
    });

    const again = await createDraft('hello-world', media.id);
    expect(again.statusCode).toBe(422);
    expect(again.json()).toEqual({ errors: { handle: ['has already been taken'] } });

    const byHandle = await call('GET', `${BLOG}/articles.json?handle=hello-world`);
    expect(byHandle.json()).toEqual({ articles: [article] });
    expect((await call('GET', `${BLOG}/articles.json?handle=other`)).json()).toEqual({
      articles: [],
    });
    expect((await call('GET', `${BLOG}/articles/${article.id}.json`)).json()).toEqual({ article });
  });

  it('accepts any numeric blog id and rejects others', async () => {
    const { article } = (await createDraft('hello-world')).json();
    expect(article.image).toBeNull();
    const other = await call('GET', `/blogs/987654/articles/${article.id}.json`);
    expect(other.json()).toEqual({ article });
    expect((await call('GET', '/blogs/news/articles.json')).statusCode).toBe(404);
  });

  it('accepts the media id as a string (the pipeline stores ids as text)', async () => {
    const media = (await upload()).json().media;
    const res = await call('POST', `${BLOG}/articles.json`, {
      article: { handle: 'hello-world', image: { media_id: String(media.id) } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().article.image).toEqual({ media_id: media.id });
  });

  it('rejects an article whose image was never uploaded, or without a handle', async () => {
    const res = await createDraft('hello-world', 4242);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ errors: { image: expect.any(Array) } });
    const noHandle = await call('POST', `${BLOG}/articles.json`, { article: { title: 'x' } });
    expect(noHandle.statusCode).toBe(400);
  });

  it('publishes, and publishing again returns the same live article', async () => {
    const draft = (await createDraft('hello-world')).json().article;
    const path = `${BLOG}/articles/${draft.id}.json`;

    const first = await call('PUT', path, { article: { published: true } });
    expect(first.statusCode).toBe(200);
    const live = first.json().article;
    expect(live).toEqual({
      ...draft,
      published: true,
      url: `http://${HOST}/shopify/blogs/news/hello-world`,
    });

    const second = await call('PUT', path, { article: { published: true } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ article: live });
    expect((await call('PUT', path, { article: { published: false } })).statusCode).toBe(400);
  });

  it('deletes an article', async () => {
    const draft = (await createDraft('hello-world')).json().article;
    const path = `${BLOG}/articles/${draft.id}.json`;
    const res = await call('DELETE', path);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect((await call('GET', path)).statusCode).toBe(404);
  });

  it('answers 404 for unknown article ids', async () => {
    const path = `${BLOG}/articles/999.json`;
    const get = await call('GET', path);
    expect(get.statusCode).toBe(404);
    expect(get.json()).toEqual({ errors: 'Not Found' });
    expect((await call('PUT', path, { article: { published: true } })).statusCode).toBe(404);
    expect((await call('DELETE', path)).statusCode).toBe(404);
  });
});
