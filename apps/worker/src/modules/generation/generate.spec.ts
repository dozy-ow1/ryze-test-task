import { classify, createLogger, Deferred, HttpError, type ImageProvider, llmCost, type Operation, SQL } from '@ryze/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, testDb } from '../../../../../packages/shared/src/testing/database.js';
import type { Clients } from '../../infrastructure/clients.js';
import { coverKey, type Store } from '../../infrastructure/store.js';
import type { StepContext } from '../../runtime/types.js';
import { imageFetch } from './image-fetch.js';
import { imageSubmit } from './image-submit.js';
import { slugify, text } from './text.js';

const ARTICLE_ID = '7d3c2a10-5b6e-4f0a-9c1d-2e3f4a5b6c7d';
let t: TestDb;
let png: Buffer;

beforeAll(async () => {
  t = await testDb();
  png = await sharp({
    create: { width: 1792, height: 1024, channels: 3, background: '#3366aa' },
  })
    .png()
    .toBuffer();
});
afterAll(() => t.drop());
beforeEach(async () => {
  await t.db.query('DELETE FROM quotas');
  await t.db.query(SQL.SEED);
});

function memoryStore(): Store & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();

  return {
    objects,

    exists: async (key) => objects.has(key),

    put: async (key, bytes) => {
      objects.set(key, bytes);
    },

    get: async (key) => objects.get(key) as Buffer,
  };
}

function ctx(clients: Partial<Clients>, op: Partial<Operation> = {}): StepContext<Clients> {
  return {
    op: {
      id: 1,
      article_id: ARTICLE_ID,
      step: 'image_fetch',
      status: 'running',
      attempts: 0,
      lease_version: 1,
      provider_ref: null,
      created_at: new Date(),
      ...op,
    },
    article: {
      id: ARTICLE_ID,
      site_id: 's',
      brief: 'How to keep basil alive',
      title: 'Keep Basil Alive',
      slug: null,
      body_html: null,
      image_prompt: 'a basil plant on a sunny windowsill',
      remote_media_id: null,
      remote_post_id: null,
    },
    site: {
      id: 's',
      platform: 'shopify',
      base_url: 'https://test-store.myshopify.com',
      token: 't',
      verified_at: null,
    },
    clients: {
      db: t.db,

      http: async () => ({ status: 200, headers: {}, body: png }),
      llm: { model: 'mock', generate: vi.fn() },
      image: { kind: 'async' },
      store: memoryStore(),
      platform: {} as Clients['platform'],
      ...clients,
    },
    log: createLogger('test', 'silent'),
    signal: new AbortController().signal,
  };
}

describe('slugify', () => {
  it('is lowercase ASCII, ends with the full article id and fits 80 characters', () => {
    expect(slugify('Hello, World!', ARTICLE_ID)).toBe(`hello-world-${ARTICLE_ID}`);
    expect(slugify('Café Crème Brûlée — 10 tips', ARTICLE_ID)).toBe(
      `cafe-creme-brulee-10-tips-${ARTICLE_ID}`,
    );
    expect(slugify('你好', ARTICLE_ID)).toBe(`article-${ARTICLE_ID}`);
    const long = slugify(`${'word '.repeat(40)}end`, ARTICLE_ID);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(long.endsWith(ARTICLE_ID)).toBe(true);
  });
});

it('keeps article identities distinct when their UUID prefixes match', () => {
  const first = 'deadbeef-1111-4111-8111-111111111111';
  const second = 'deadbeef-2222-4222-8222-222222222222';
  expect(slugify('Same title', first)).not.toBe(slugify('Same title', second));
});

describe('text', () => {
  it('writes the four text columns and prices the usage', async () => {
    const usage = { input_tokens: 600, output_tokens: 500 };

    const generate = vi.fn(async () => ({
      title: 'Keep Basil Alive',
      bodyHtml: '<p>water</p>',
      imagePrompt: 'basil',
      usage,
    }));

    const out = await text(ctx({ llm: { model: 'mock', generate } }));
    expect(generate).toHaveBeenCalledWith(
      { brief: 'How to keep basil alive' },
      expect.any(AbortSignal),
    );
    expect(out.write).toEqual({
      sql: SQL.WRITE_TEXT,
      params: [
        ARTICLE_ID,
        'Keep Basil Alive',
        `keep-basil-alive-${ARTICLE_ID}`,
        '<p>water</p>',
        'basil',
      ],
    });
    expect(out.usage).toEqual({ ...usage, model: 'mock', cost_usd: llmCost('mock', usage) });
  });

  it('waits for the provider:llm bucket instead of calling', async () => {
    await t.db.query("DELETE FROM quotas WHERE scope = 'provider:llm'");
    await t.db.query(SQL.SITE_QUOTA, ['provider:llm', 4000, 1]);
    const generate = vi.fn(async () => ({
      title: 't',
      bodyHtml: 'b',
      imagePrompt: 'p',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await text(ctx({ llm: { model: 'mock', generate } }));
    await expect(text(ctx({ llm: { model: 'mock', generate } }))).rejects.toBeInstanceOf(Deferred);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('image_submit', () => {
  it('hands the job id to the next row', async () => {
    const submit = vi.fn(async () => ({ jobId: 'job-42' }));

    const out = await imageSubmit(ctx({ image: { kind: 'async', submit } }));
    expect(submit).toHaveBeenCalledWith(
      'a basil plant on a sunny windowsill',
      expect.any(AbortSignal),
    );
    expect(out).toEqual({ providerRef: 'job-42' });
  });
});

describe('image_fetch', () => {
  it('pays nothing when an earlier attempt already stored the cover', async () => {
    const store = memoryStore();
    store.objects.set(coverKey(ARTICLE_ID), Buffer.from('jpeg'));
    const image: ImageProvider = { kind: 'async', poll: vi.fn(), generate: vi.fn() };

    const out = await imageFetch(ctx({ store, image }, { provider_ref: 'job-1' }));
    expect(out.usage).toEqual({ images: 1, model: 'mock', cost_usd: 0.04 });
    expect(image.poll).not.toHaveBeenCalled();
  });

  it('defers a pending job, then stores its completed 1200x630 JPEG without resubmitting', async () => {
    const store = memoryStore();
    const states = ['pending', 'done'] as const;

    const poll = vi.fn(async () => {
      const status = states[Math.min(poll.mock.calls.length - 1, 1)];

      return status === 'done' ? { status, url: 'http://img/job-1/file' } : { status };
    });

    const context = ctx({ store, image: { kind: 'async', poll } }, { provider_ref: 'job-1' });
    await expect(imageFetch(context)).rejects.toBeInstanceOf(Deferred);
    const out = await imageFetch(context);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledWith('job-1', expect.any(AbortSignal));
    const meta = await sharp(store.objects.get(coverKey(ARTICLE_ID))).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 630 });
    expect(out.usage).toEqual({ images: 1, model: 'mock', cost_usd: 0.04 });
  });

  it('keeps the original polling deadline across queue attempts', async () => {
    const poll = vi.fn(async () => ({ status: 'pending' as const }));

    const context = ctx(
      { image: { kind: 'async', poll } },
      { provider_ref: 'job-1', created_at: new Date(Date.now() - 121_000) },
    );

    const error = await imageFetch(context).catch((err) => err);
    expect(classify(error)).toBe('permanent');
    expect(error.message).toContain('did not finish');
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('accepts a completed image even after queue delays and rejects a missing result URL', async () => {
    const store = memoryStore();

    const context = ctx(
      {
        store,
        image: {
          kind: 'async',

          poll: async () => ({ status: 'done', url: 'https://images.example/cover' }),
        },
      },
      { provider_ref: 'job', created_at: new Date(Date.now() - 180_000) },
    );
    await imageFetch(context);
    expect(store.objects.has(coverKey(ARTICLE_ID))).toBe(true);
    const invalid = ctx(
      { image: { kind: 'async', poll: async () => ({ status: 'done' }) } },
      { provider_ref: 'job' },
    );

    const error = await imageFetch(invalid).catch((err) => err);
    expect(classify(error)).toBe('permanent');
    expect(error.message).toContain('no download URL');
  });

  it('treats a job the provider does not know as permanent', async () => {
    const poll = vi.fn(async () => {
      throw new HttpError(404, 'no such job');
    });

    const err = await imageFetch(
      ctx({ image: { kind: 'async', poll } }, { provider_ref: 'gone' }),
    ).catch((e) => e);
    expect(classify(err)).toBe('permanent');
  });

  it('generates under the provider:image quota with a sync provider', async () => {
    const store = memoryStore();
    const generate = vi.fn(async () => png);
    await imageFetch(ctx({ store, image: { kind: 'sync', generate } }));
    expect(generate).toHaveBeenCalledWith(
      'a basil plant on a sunny windowsill',
      expect.any(AbortSignal),
    );
    expect(store.objects.has(coverKey(ARTICLE_ID))).toBe(true);
  });
});
