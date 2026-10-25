import {
  classify,
  createLogger,
  Deferred,
  HttpError,
  type ImageProvider,
  llmCost,
  type Operation,
  SQL,
} from '@ryze/core';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, testDb } from '../../../test/support/db.js';
import type { Clients } from '../src/clients.js';
import type { StepContext } from '../src/runner.js';
import { imageFetch } from '../src/steps/image_fetch.js';
import { imageSubmit } from '../src/steps/image_submit.js';
import { slugify, text } from '../src/steps/text.js';
import { coverKey, type Store } from '../src/store.js';

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
beforeEach(() => t.db.query('DELETE FROM quotas'));

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
    site: { id: 's', platform: 'wordpress', base_url: 'http://wp', token: 't', verified_at: null },
    clients: {
      db: t.db,
      http: async () => ({ status: 200, headers: {}, body: png }),
      llm: { model: 'fake', generate: vi.fn() },
      image: { kind: 'async' },
      store: memoryStore(),
      adapters: {} as Clients['adapters'],
      ...clients,
    },
    log: createLogger('test', 'silent'),
    signal: new AbortController().signal,
  };
}

describe('slugify', () => {
  it('is lowercase ASCII, ends with the article id prefix and fits 80 characters', () => {
    expect(slugify('Hello, World!', ARTICLE_ID)).toBe('hello-world-7d3c2a10');
    expect(slugify('Café Crème Brûlée — 10 tips', ARTICLE_ID)).toBe(
      'cafe-creme-brulee-10-tips-7d3c2a10',
    );
    expect(slugify('你好', ARTICLE_ID)).toBe('article-7d3c2a10');
    const long = slugify(`${'word '.repeat(40)}end`, ARTICLE_ID);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-7d3c2a10$/);
  });
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
    const out = await text(ctx({ llm: { model: 'fake', generate } }));
    expect(generate).toHaveBeenCalledWith({ brief: 'How to keep basil alive' });
    expect(out.write).toEqual({
      sql: SQL.WRITE_TEXT,
      params: [
        ARTICLE_ID,
        'Keep Basil Alive',
        'keep-basil-alive-7d3c2a10',
        '<p>water</p>',
        'basil',
      ],
    });
    expect(out.usage).toEqual({ ...usage, cost_usd: llmCost('fake', usage) });
  });

  it('waits for the provider:llm bucket instead of calling', async () => {
    await t.db.query(SQL.SITE_QUOTA, ['provider:llm', 4000, 1]);
    const generate = vi.fn(async () => ({
      title: 't',
      bodyHtml: 'b',
      imagePrompt: 'p',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await text(ctx({ llm: { model: 'fake', generate } }));
    await expect(text(ctx({ llm: { model: 'fake', generate } }))).rejects.toBeInstanceOf(Deferred);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('image_submit', () => {
  it('hands the job id to the next row', async () => {
    const submit = vi.fn(async () => ({ jobId: 'job-42' }));
    const out = await imageSubmit(ctx({ image: { kind: 'async', submit } }));
    expect(submit).toHaveBeenCalledWith('a basil plant on a sunny windowsill');
    expect(out).toEqual({ providerRef: 'job-42' });
  });
});

describe('image_fetch', () => {
  it('pays nothing when an earlier attempt already stored the cover', async () => {
    const store = memoryStore();
    store.objects.set(coverKey(ARTICLE_ID), Buffer.from('jpeg'));
    const image: ImageProvider = { kind: 'async', poll: vi.fn(), generate: vi.fn() };
    const out = await imageFetch(ctx({ store, image }, { provider_ref: 'job-1' }));
    expect(out.usage).toEqual({ images: 1, cost_usd: 0.04 });
    expect(image.poll).not.toHaveBeenCalled();
  });

  it('polls the job it was given, then stores a 1200x630 JPEG under the article key', async () => {
    const store = memoryStore();
    const states = ['pending', 'done'] as const;
    const poll = vi.fn(async () => {
      const status = states[Math.min(poll.mock.calls.length - 1, 1)];
      return status === 'done' ? { status, url: 'http://img/job-1/file' } : { status };
    });
    const out = await imageFetch(
      ctx({ store, image: { kind: 'async', poll } }, { provider_ref: 'job-1' }),
    );
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledWith('job-1');
    const meta = await sharp(store.objects.get(coverKey(ARTICLE_ID))).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 630 });
    expect(out.usage).toEqual({ images: 1, cost_usd: 0.04 });
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
    expect(generate).toHaveBeenCalledWith('a basil plant on a sunny windowsill');
    expect(store.objects.has(coverKey(ARTICLE_ID))).toBe(true);
  });
});
