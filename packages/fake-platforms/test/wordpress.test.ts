import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeApps, HOST, JPEG, makeApp, registerSite, WP } from './helpers.js';

const ARTICLE = '0b7e2a3c-5d1f-4c6a-9e8b-7f2d1c0a9b8e';
const STEM = `ryze-${ARTICLE}`;

let app: FastifyInstance;

beforeEach(async () => {
  app = makeApp();
  await registerSite(app, 'wp-token', 'wordpress');
});
afterEach(closeApps);

function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  extra: { headers?: Record<string, string>; payload?: object | Buffer } = {},
) {
  return app.inject({
    method,
    url: `${WP}${path}`,
    headers: { authorization: 'Bearer wp-token', host: HOST, ...extra.headers },
    payload: extra.payload,
  });
}

function upload(filename = `${STEM}.jpg`, bytes = JPEG) {
  return call('POST', '/media', {
    headers: {
      'content-type': 'image/jpeg',
      'content-disposition': `attachment; filename="${filename}"`,
    },
    payload: bytes,
  });
}

function createDraft(slug: string, featuredMedia?: number) {
  return call('POST', '/posts', {
    payload: {
      title: 'Hello',
      slug,
      content: '<p>Hi</p>',
      status: 'draft',
      featured_media: featuredMedia,
      meta: { ryze_article_id: ARTICLE },
    },
  });
}

describe('WordPress', () => {
  it('answers the verify call', async () => {
    const res = await call('GET', '/users/me');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 1, name: 'ryze-editor' });
  });

  it('uploads raw image bytes and finds them by file stem, ignoring case', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const media = res.json();
    expect(media).toEqual({
      id: expect.any(Number),
      slug: STEM,
      source_url: `http://${HOST}/wordpress/uploads/${STEM}.jpg`,
    });

    expect((await call('GET', `/media?search=${STEM.toUpperCase()}`)).json()).toEqual([media]);
    expect((await call('GET', '/media?search=ryze-someone-else')).json()).toEqual([]);
  });

  it('stores a repeated file name as a second item with the next slug', async () => {
    const first = (await upload()).json();
    const second = (await upload()).json();
    const third = (await upload()).json();
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(second.slug).toBe(`${STEM}-2`);
    expect(second.source_url).toBe(`http://${HOST}/wordpress/uploads/${STEM}-2.jpg`);
    expect(third.slug).toBe(`${STEM}-3`);
    expect((await call('GET', `/media?search=${STEM}`)).json()).toEqual([first, second, third]);
  });

  it('rejects an upload without a file name or without bytes', async () => {
    const unnamed = await call('POST', '/media', {
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    expect(unnamed.statusCode).toBe(400);
    expect((await upload(`${STEM}.jpg`, Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('accepts images up to 10 MB', async () => {
    expect((await upload(`${STEM}.jpg`, Buffer.alloc(3 * 1024 * 1024, 1))).statusCode).toBe(201);
    expect((await upload(`${STEM}.jpg`, Buffer.alloc(11 * 1024 * 1024, 1))).statusCode).toBe(413);
  });

  it('creates a draft once per slug and finds it by slug and by id', async () => {
    const media = (await upload()).json();
    const res = await createDraft('hello-world', media.id);
    expect(res.statusCode).toBe(201);
    const post = res.json();
    expect(post).toEqual({
      id: expect.any(Number),
      slug: 'hello-world',
      status: 'draft',
      link: `http://${HOST}/wordpress/?p=${post.id}`,
      title: { rendered: 'Hello' },
      content: { rendered: '<p>Hi</p>' },
      featured_media: media.id,
      meta: { ryze_article_id: ARTICLE },
    });

    const again = await createDraft('hello-world', media.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'slug_exists' });

    expect((await call('GET', '/posts?slug=hello-world&status=any')).json()).toEqual([post]);
    // As on WordPress, a list without a status shows published posts only.
    expect((await call('GET', '/posts?slug=hello-world')).json()).toEqual([]);
    expect((await call('GET', '/posts?slug=other&status=any')).json()).toEqual([]);
    expect((await call('GET', `/posts/${post.id}`)).json()).toEqual(post);
  });

  it('accepts the featured media id as a string (the pipeline stores ids as text)', async () => {
    const media = (await upload()).json();
    const res = await call('POST', '/posts', {
      payload: { slug: 'hello-world', featured_media: String(media.id) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().featured_media).toBe(media.id);
  });

  it('rejects a draft whose featured image was never uploaded, or without a slug', async () => {
    const res = await createDraft('hello-world', 4242);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'rest_invalid_featured_media' });
    expect((await call('POST', '/posts', { payload: { title: 'No slug' } })).statusCode).toBe(400);
  });

  it('publishes, and publishing again returns the same live post', async () => {
    const draft = (await createDraft('hello-world')).json();
    expect(draft.featured_media).toBe(0);

    const first = await call('POST', `/posts/${draft.id}`, { payload: { status: 'publish' } });
    expect(first.statusCode).toBe(200);
    const live = first.json();
    expect(live).toEqual({
      ...draft,
      status: 'publish',
      link: `http://${HOST}/wordpress/blog/hello-world`,
    });

    const second = await call('POST', `/posts/${draft.id}`, { payload: { status: 'publish' } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(live);
    expect((await call('GET', '/posts?slug=hello-world')).json()).toEqual([live]);
  });

  it('only supports publishing as an update', async () => {
    const draft = (await createDraft('hello-world')).json();
    const res = await call('POST', `/posts/${draft.id}`, { payload: { status: 'trash' } });
    expect(res.statusCode).toBe(400);
  });

  it('deletes a post', async () => {
    const draft = (await createDraft('hello-world')).json();
    const res = await call('DELETE', `/posts/${draft.id}?force=true`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, previous: draft });
    expect((await call('GET', `/posts/${draft.id}`)).statusCode).toBe(404);
    expect((await createDraft('hello-world')).statusCode).toBe(201);
  });

  it('answers 404 for unknown post ids', async () => {
    expect((await call('GET', '/posts/999')).statusCode).toBe(404);
    const publish = await call('POST', '/posts/999', { payload: { status: 'publish' } });
    expect(publish.statusCode).toBe(404);
    expect(publish.json()).toMatchObject({ code: 'rest_post_invalid_id' });
    expect((await call('DELETE', '/posts/999?force=true')).statusCode).toBe(404);
  });
});
