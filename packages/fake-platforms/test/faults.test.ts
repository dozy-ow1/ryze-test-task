import { FAULT_KINDS, type FaultKind } from '@ryze/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppOptions } from '../src/app.js';
import { closeApps, inspect, JPEG, listen, makeApp, registerSite, SHOP, WP } from './helpers.js';

afterEach(closeApps);

const SHORT: AppOptions['delays'] = { slowMs: [50, 60], timeoutHoldMs: 300 };

// A WordPress site 'wp' whose every write gets `kind`, served on a real socket: inject() cannot show
// a dropped or held connection.
async function serve(kind: FaultKind): Promise<{ app: FastifyInstance; base: string }> {
  const app = makeApp({ delays: SHORT });
  await registerSite(app, 'wp', 'wordpress', { rate: 1, kinds: [kind] });
  return { app, base: await listen(app) };
}

function send(
  method: 'POST' | 'PUT',
  url: string,
  token: string,
  body: object,
  signal?: AbortSignal,
) {
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function createDraft(base: string, signal?: AbortSignal) {
  const body = { title: 'Hello', slug: 'hello-world', meta: { ryze_article_id: 'a1' } };
  return send('POST', `${base}${WP}/posts`, 'wp', body, signal);
}

function uploadImage(base: string) {
  return fetch(`${base}${WP}/media`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer wp',
      'content-type': 'image/jpeg',
      'content-disposition': 'attachment; filename="ryze-a1.jpg"',
    },
    body: JPEG,
  });
}

async function onlySite(app: FastifyInstance) {
  const { sites } = await inspect(app);
  expect(sites).toHaveLength(1);
  return sites[0];
}

describe('faults on writes', () => {
  it('429 answers with Retry-After and writes nothing', async () => {
    const { app, base } = await serve('429');
    const res = await createDraft(base);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect((await uploadImage(base)).status).toBe(429);

    const site = await onlySite(app);
    expect(site.posts).toEqual([]);
    expect(site.media).toEqual([]);
    expect(site.faults_injected).toMatchObject({ '429': 2, '500': 0 });
  });

  it('500 writes nothing', async () => {
    const { app, base } = await serve('500');
    const res = await createDraft(base);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String) });

    const site = await onlySite(app);
    expect(site.posts).toEqual([]);
    expect(site.faults_injected['500']).toBe(1);
  });

  it('complete_then_drop writes, then drops the connection without an answer', async () => {
    const { app, base } = await serve('complete_then_drop');
    await expect(createDraft(base)).rejects.toThrow('fetch failed');
    await expect(uploadImage(base)).rejects.toThrow('fetch failed');

    const site = await onlySite(app);
    expect(site.posts).toMatchObject([{ slug: 'hello-world', status: 'draft', article_id: 'a1' }]);
    expect(site.media).toMatchObject([{ filename: 'ryze-a1.jpg' }]);
    expect(site.faults_injected.complete_then_drop).toBe(2);
  });

  it('complete_then_drop on a publish leaves the post live', async () => {
    const app = makeApp();
    await registerSite(app, 'wp', 'wordpress', { rate: 0 });
    await registerSite(app, 'shop', 'shopify', { rate: 0 });
    const wpDraft = await app.inject({
      method: 'POST',
      url: `${WP}/posts`,
      headers: { authorization: 'Bearer wp' },
      payload: { slug: 'hello-world' },
    });
    const shopDraft = await app.inject({
      method: 'POST',
      url: `${SHOP}/blogs/1/articles.json`,
      headers: { authorization: 'Bearer shop' },
      payload: { article: { handle: 'hello-world' } },
    });
    const drop = { rate: 1, kinds: ['complete_then_drop' as const] };
    await registerSite(app, 'wp', 'wordpress', drop);
    await registerSite(app, 'shop', 'shopify', drop);
    const base = await listen(app);

    const wpUrl = `${base}${WP}/posts/${wpDraft.json().id}`;
    await expect(send('POST', wpUrl, 'wp', { status: 'publish' })).rejects.toThrow('fetch failed');
    const shopUrl = `${base}${SHOP}/blogs/1/articles/${shopDraft.json().article.id}.json`;
    const publish = { article: { published: true } };
    await expect(send('PUT', shopUrl, 'shop', publish)).rejects.toThrow('fetch failed');

    const { sites } = await inspect(app);
    expect(sites.map((s) => s.posts.map((p) => p.status))).toEqual([['live'], ['live']]);
    expect(sites.map((s) => s.faults_injected.complete_then_drop)).toEqual([1, 1]);
  });

  it('timeout never answers and writes nothing', async () => {
    const { app, base } = await serve('timeout');
    await expect(createDraft(base, AbortSignal.timeout(100))).rejects.toMatchObject({
      name: 'TimeoutError',
    });

    const site = await onlySite(app);
    expect(site.posts).toEqual([]);
    expect(site.faults_injected.timeout).toBe(1);
  });

  it('timeout destroys the held connection once the hold is over', async () => {
    const { base } = await serve('timeout');
    const started = Date.now();
    await expect(createDraft(base)).rejects.toThrow('fetch failed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('slow answers late, normally, and writes', async () => {
    const { app, base } = await serve('slow');
    const started = Date.now();
    const res = await createDraft(base);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: 'hello-world', status: 'draft' });

    const site = await onlySite(app);
    expect(site.posts).toHaveLength(1);
    expect(site.faults_injected.slow).toBe(1);
  });

  it('never faults reads, deletes, admin or health', async () => {
    const app = makeApp({ faultRate: 0, faultKinds: [...FAULT_KINDS] });
    await registerSite(app, 'wp', 'wordpress');
    await registerSite(app, 'shop', 'shopify');
    const wp = { authorization: 'Bearer wp' };
    const shop = { authorization: 'Bearer shop' };
    const post = (
      await app.inject({ method: 'POST', url: `${WP}/posts`, headers: wp, payload: { slug: 's' } })
    ).json();
    const article = (
      await app.inject({
        method: 'POST',
        url: `${SHOP}/blogs/1/articles.json`,
        headers: shop,
        payload: { article: { handle: 's' } },
      })
    ).json().article;

    // From here every write would fail with a 500.
    const always500 = { rate: 1, kinds: ['500' as const] };
    await registerSite(app, 'wp', 'wordpress', always500);
    await registerSite(app, 'shop', 'shopify', always500);
    const base = await listen(app);
    const calls: [string, Record<string, string>, string?][] = [
      [`${WP}/users/me`, wp],
      [`${WP}/media?search=ryze`, wp],
      [`${WP}/posts?slug=s&status=any`, wp],
      [`${WP}/posts/${post.id}`, wp],
      [`${WP}/posts/${post.id}?force=true`, wp, 'DELETE'],
      [`${SHOP}/shop.json`, shop],
      [`${SHOP}/media.json?filename=x.jpg`, shop],
      [`${SHOP}/blogs/1/articles.json?handle=s`, shop],
      [`${SHOP}/blogs/1/articles/${article.id}.json`, shop],
      [`${SHOP}/blogs/1/articles/${article.id}.json`, shop, 'DELETE'],
      ['/_admin/inspect', {}],
      ['/healthz', {}],
    ];
    for (const [path, headers, method = 'GET'] of calls) {
      const res = await fetch(`${base}${path}`, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect((await inspect(app)).sites.map((s) => s.faults_injected['500'])).toEqual([0, 0]);

    expect((await createDraft(base)).status).toBe(500);
  });

  it("uses a site's own faults over the app defaults", async () => {
    const app = makeApp({ faultRate: 1, faultKinds: ['500'] });
    await registerSite(app, 'defaults', 'wordpress');
    await registerSite(app, 'quiet', 'wordpress', { rate: 0 });
    await registerSite(app, 'limited', 'wordpress', { kinds: ['429'] });
    const draft = (token: string) =>
      app.inject({
        method: 'POST',
        url: `${WP}/posts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { slug: 'hello-world' },
      });

    expect((await draft('defaults')).statusCode).toBe(500);
    expect((await draft('quiet')).statusCode).toBe(201);
    expect((await draft('limited')).statusCode).toBe(429);

    const { sites } = await inspect(app);
    expect(sites.map((s) => [s.token, s.faults, s.posts.length])).toEqual([
      ['defaults', { rate: 1, kinds: ['500'] }, 0],
      ['quiet', { rate: 0, kinds: ['500'] }, 1],
      ['limited', { rate: 1, kinds: ['429'] }, 0],
    ]);
  });

  it('faults a write with probability rate, its kind drawn uniformly from kinds', async () => {
    const draws = [0.5, 0.49, 0.75, 0.49, 0.2];
    const app = makeApp({ random: () => draws.shift() ?? 1 });
    await registerSite(app, 'wp', 'wordpress', { rate: 0.5, kinds: ['429', '500'] });
    const draft = (slug: string) =>
      app.inject({
        method: 'POST',
        url: `${WP}/posts`,
        headers: { authorization: 'Bearer wp' },
        payload: { slug },
      });

    expect((await draft('a')).statusCode).toBe(201); // 0.5 is not below the rate
    expect((await draft('b')).statusCode).toBe(500); // 0.49 is; 0.75 picks the second kind
    expect((await draft('c')).statusCode).toBe(429); // 0.49 is; 0.2 picks the first kind
    expect(draws).toEqual([]);
  });

  it('close() does not wait for held or slow requests', async () => {
    const app = makeApp({ delays: { slowMs: [60_000, 60_000], timeoutHoldMs: 60_000 } });
    await registerSite(app, 'held', 'wordpress', { rate: 1, kinds: ['timeout'] });
    await registerSite(app, 'slow', 'wordpress', { rate: 1, kinds: ['slow'] });
    const base = await listen(app);
    const outcomes = ['held', 'slow'].map((token) =>
      send('POST', `${base}${WP}/posts`, token, { slug: 'hello-world' }).then(
        () => 'answered',
        () => 'dropped',
      ),
    );
    await vi.waitFor(async () => {
      const [held, slow] = (await inspect(app)).sites;
      expect([held.faults_injected.timeout, slow.faults_injected.slow]).toEqual([1, 1]);
    });

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await Promise.all(outcomes)).toEqual(['dropped', 'dropped']);
  });
});
