import {
  classify,
  createHttp,
  createLogger,
  createShopify,
  createWordPress,
  HttpError,
  isAuthError,
  type PlatformAdapter,
  type Site,
} from '@ryze/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../../../test/support/database.js';
import { buildApp } from '../../../fake-platforms/src/app.js';
import type { Clients } from '../clients.js';
import type { StepContext, StepFn } from '../runner.js';
import { coverKey, type Store } from '../store.js';
import { draft } from './draft.js';
import { publish } from './publish.js';
import { upload } from './upload.js';
import { verify } from './verify.js';

// The worker's adapters against the fake platforms the demo uses: the same contract, and the
// recovery path when a write happens but its answer is lost.

const fake = buildApp({ faultRate: 0, faultKinds: [] });
const http = createHttp(5_000, { allowPrivateNetwork: true });
const adapters = { wordpress: createWordPress(http), shopify: createShopify(http) };
let base: string;
let t: TestDb;

beforeAll(async () => {
  t = await testDb();
  await fake.listen({ port: 0, host: '127.0.0.1' });
  const address = fake.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await fake.close();
  await t.drop();
});

async function site(platform: Site['platform'], dropWrites = false): Promise<Site> {
  const token = `${platform}-${Math.random().toString(36).slice(2)}`;
  await register(token, platform, dropWrites);
  const base_url =
    platform === 'wordpress' ? `${base}/wordpress` : `${base}/shopify/admin/api/2026-10/blogs/1`;
  return { id: crypto.randomUUID(), platform, base_url, token };
}

async function register(token: string, platform: string, dropWrites: boolean) {
  const faults = dropWrites ? { rate: 1, kinds: ['complete_then_drop'] } : { rate: 0, kinds: [] };
  const res = await fetch(`${base}/_admin/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, platform, faults }),
  });
  expect(res.status).toBe(201);
}

async function inspect(token: string) {
  const res = await fetch(`${base}/_admin/inspect`);
  const body = (await res.json()) as {
    sites: {
      token: string;
      media: { filename: string }[];
      posts: { id: string; status: string }[];
    }[];
  };
  return body.sites.find((s) => s.token === token) as (typeof body.sites)[number];
}

describe.each(['wordpress', 'shopify'] as const)('%s adapter', (platform) => {
  const adapter = (): PlatformAdapter => adapters[platform];

  it('finds what it created and publishes idempotently', async () => {
    const s = await site(platform);
    await adapter().verify(s);
    const articleId = crypto.randomUUID();
    const filename = `ryze-${articleId}.jpg`;
    expect(await adapter().findMedia(s, filename)).toBeNull();
    const mediaId = await adapter().uploadMedia(s, filename, Buffer.from('jpeg bytes'));
    expect(await adapter().findMedia(s, filename)).toBe(platform === 'wordpress' ? mediaId : null);

    const slug = `hello-world-${articleId.slice(0, 8)}`;
    expect(await adapter().findBySlug(s, slug)).toBeNull();
    const input = {
      title: 'Hello world',
      slug,
      bodyHtml: '<p>hi</p>',
      mediaId,
      articleId,
      image: async () => Buffer.from('jpeg bytes'),
    };
    const postId = await adapter().createDraft(s, input);
    expect(await adapter().findBySlug(s, slug)).toMatchObject({ id: postId, status: 'draft' });
    expect(await adapter().createDraft(s, input)).toBe(postId); // a taken slug is adopted

    expect(await adapter().getStatus(s, postId)).toMatchObject({ status: 'draft' });
    const url = await adapter().publish(s, postId);
    expect(url).toContain(slug);
    expect(await adapter().getStatus(s, postId)).toMatchObject({ status: 'live', url });
    expect(await adapter().publish(s, postId)).toBe(url);

    const stray = await adapter().createDraft(s, {
      ...input,
      slug: `stray-${articleId.slice(0, 8)}`,
    });
    await adapter().deleteDraft(s, stray);
    const after = await inspect(s.token);
    expect(after.posts.map((p) => p.id)).toEqual([postId]);
    expect(after.media).toHaveLength(1);
  });

  it('reports a bad token as a permanent auth error', async () => {
    const s = await site(platform);
    const err = await adapter()
      .verify({ ...s, token: 'nope' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(classify(err)).toBe('permanent');
    expect(isAuthError(err)).toBe(true);
  });
});

describe.each(['wordpress', 'shopify'] as const)(
  '%s steps when a write answer is lost',
  (platform) => {
    it('upload, draft and publish each take effect exactly once', async () => {
      const s = await site(platform, true); // every write happens, then its socket is dropped
      const articleId = crypto.randomUUID();
      const store: Store = {
        exists: async () => true,
        put: async () => {},
        get: async (key) => {
          expect(key).toBe(coverKey(articleId));
          return Buffer.from('cover');
        },
      };
      const article: StepContext<Clients>['article'] = {
        id: articleId,
        site_id: s.id,
        brief: 'b',
        title: 'Lost answers',
        slug: `lost-answers-${articleId.slice(0, 8)}`,
        body_html: '<p>body</p>',
        image_prompt: 'p',
        remote_media_id: null,
        remote_post_id: null,
      };
      const ctx = (): StepContext<Clients> => ({
        op: {
          id: 1,
          article_id: articleId,
          step: 'upload',
          status: 'running',
          attempts: 0,
          lease_version: 1,
          provider_ref: null,
        },
        article,
        site: { ...s, verified_at: null },
        clients: { db: t.db, http, store, adapters } as unknown as Clients,
        log: createLogger('test', 'silent'),
        signal: new AbortController().signal,
      });
      // First attempt: the write lands but the answer never comes back. Second attempt: no faults.
      const twice = async (step: StepFn<Clients>) => {
        await register(s.token, platform, true);
        const first = await step(ctx()).catch((e) => e);
        expect(first).toBeInstanceOf(HttpError);
        expect(classify(first)).toBe('transient');
        await register(s.token, platform, false);
        return step(ctx());
      };

      expect(await verify(ctx())).toMatchObject({ write: { params: [s.id, null] } });
      const uploaded = platform === 'wordpress' ? await twice(upload) : await upload(ctx());
      article.remote_media_id = uploaded.write?.params[1] as string;
      const drafted = await twice(draft);
      article.remote_post_id = drafted.write?.params[1] as string;
      const published = await twice(publish);

      const state = await inspect(s.token);
      expect(state.media).toHaveLength(1);
      expect(state.posts).toEqual([
        expect.objectContaining({ id: article.remote_post_id, status: 'live' }),
      ]);
      expect(String(published.write?.params[1])).toContain(article.slug);
    });
  },
);

describe('upload', () => {
  it('reuses an uploaded cover without reading it from the store again', async () => {
    const s = await site('wordpress');
    const articleId = crypto.randomUUID();
    const mediaId = await adapters.wordpress.uploadMedia(
      s,
      `ryze-${articleId}.jpg`,
      Buffer.from('cover'),
    );
    let reads = 0;
    const store: Store = {
      exists: async () => true,
      put: async () => {},
      get: async () => {
        reads++;
        return Buffer.from('cover');
      },
    };
    const out = await upload({
      op: {
        id: 1,
        article_id: articleId,
        step: 'upload',
        status: 'running',
        attempts: 1,
        lease_version: 2,
        provider_ref: null,
      },
      article: {
        id: articleId,
        site_id: s.id,
        brief: 'b',
        title: 't',
        slug: 's',
        body_html: '<p>b</p>',
        image_prompt: 'p',
        remote_media_id: null,
        remote_post_id: null,
      },
      site: { ...s, verified_at: null },
      clients: { db: t.db, http, store, adapters } as unknown as Clients,
      log: createLogger('test', 'silent'),
      signal: new AbortController().signal,
    });
    expect(out.write?.params[1]).toBe(mediaId);
    expect(reads).toBe(0);
  });
});

describe('draft ownership', () => {
  it('rejects a matching slug belonging to another article', async () => {
    const s = await site('wordpress');
    await t.db.query(
      'INSERT INTO quotas (scope, capacity, refill, tokens) VALUES ($1, 10, 2, 10)',
      [`site:${s.id}`],
    );
    let created = false;
    const adapter = {
      findBySlug: async () => ({
        id: 'foreign-post',
        status: 'draft' as const,
        articleId: crypto.randomUUID(),
      }),
      createDraft: async () => {
        created = true;
        return 'new-post';
      },
    };
    const articleId = crypto.randomUUID();
    const ctx = {
      article: {
        id: articleId,
        site_id: s.id,
        brief: 'b',
        title: 'Title',
        slug: `title-${articleId}`,
        body_html: '<p>body</p>',
        image_prompt: 'image',
        remote_media_id: 'media',
        remote_post_id: null,
      },
      site: { ...s, verified_at: null },
      clients: { db: t.db, adapters: { wordpress: adapter } } as unknown as Clients,
      signal: new AbortController().signal,
    } as StepContext<Clients>;
    await expect(draft(ctx)).rejects.toThrow('slug belongs to another article');
    expect(created).toBe(false);
  });
});
