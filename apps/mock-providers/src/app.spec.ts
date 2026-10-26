import { setTimeout as sleep } from 'node:timers/promises';
import { FAULT_KINDS, IMAGE_PRICE_USD, llmCost } from '@ryze/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppOptions, buildApp } from './app.js';
import type { Delays } from './modules/generation/runtime.js';

// Request/response behaviour through inject(). Faults are covered over real sockets in faults.spec.ts.

const FAST: Partial<Delays> = { textWorkMs: [1, 1], jobReadyMs: [250, 250] };
const BRIEF = 'Spring lawn care tips for first-time homeowners';
const ZERO_FAULTS = Object.fromEntries(FAULT_KINDS.map((kind) => [kind, 0]));

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

function build(options: Partial<AppOptions> = {}) {
  app = buildApp({ faultRate: 0, faultKinds: [...FAULT_KINDS], delays: FAST, ...options });
}

function post(url: string, payload?: object) {
  return app.inject({ method: 'POST', url, payload });
}

async function counters() {
  return (await app.inject('/_admin/counters')).json();
}

describe('POST /v1/text', () => {
  it('returns the same article for the same brief and counts the spend of each call', async () => {
    build();
    const first = await post('/v1/text', { brief: BRIEF });

    const second = await post('/v1/text', { brief: BRIEF });

    expect(first.statusCode).toBe(200);
    const article = first.json();
    expect(second.json()).toEqual(article);
    expect(article).toEqual({
      title: expect.stringMatching(/^Spring lawn care tips/),
      body_html: expect.stringMatching(/^<p>.*<\/p>$/s),
      image_prompt: expect.stringContaining(article.title),
      usage: {
        input_tokens: 500 + Math.ceil(BRIEF.length / 4),
        output_tokens: expect.any(Number),
      },
    });
    expect(article.title.length).toBeLessThanOrEqual(70);

    const cost = llmCost('mock', article.usage) ?? Number.NaN;
    expect(cost).toBeGreaterThan(0);
    expect(await counters()).toMatchObject({ text_calls: 2, image_jobs: 0, spend_usd: 2 * cost });
  });

  it('rejects a missing or empty brief without counting anything', async () => {
    build();

    for (const payload of [undefined, {}, { brief: '' }]) {
      const res = await post('/v1/text', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toEqual(expect.any(String));
    }

    expect(await counters()).toMatchObject({ text_calls: 0, spend_usd: 0 });
  });
});

describe('image jobs', () => {
  it('are pending, then done after the configured delay, then serve a 1792x1024 PNG', async () => {
    build();
    const submit = await post('/v1/images', { prompt: 'a red barn at dawn' });
    expect(submit.statusCode).toBe(200);
    const { job_id } = submit.json();
    expect(job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await counters()).toMatchObject({ image_jobs: 1, spend_usd: IMAGE_PRICE_USD });

    expect((await app.inject(`/v1/images/${job_id}`)).json()).toEqual({ status: 'pending' });
    const early = await app.inject(`/v1/images/${job_id}/file`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toEqual(expect.any(String));

    await sleep(300);
    const url = `/v1/images/${job_id}/file`;
    expect((await app.inject(`/v1/images/${job_id}`)).json()).toEqual({ status: 'done', url });
    const file = await app.inject(url);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    const { format, width, height } = await sharp(file.rawPayload).metadata();
    expect({ format, width, height }).toEqual({ format: 'png', width: 1792, height: 1024 });

    // Polls and downloads are free.
    expect(await counters()).toMatchObject({ image_jobs: 1, spend_usd: IMAGE_PRICE_USD });
  });

  it('answers 404 for an unknown job', async () => {
    build();

    for (const url of ['/v1/images/nope', '/v1/images/nope/file']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error).toEqual(expect.any(String));
    }
  });

  it('rejects a missing prompt without creating a job', async () => {
    build();

    for (const payload of [undefined, {}, { prompt: '' }]) {
      expect((await post('/v1/images', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }

    expect(await counters()).toMatchObject({ image_jobs: 0, spend_usd: 0 });
  });
});

describe('admin', () => {
  it('reports every fault kind of both groups, starting at zero', async () => {
    build();
    expect(await counters()).toEqual({
      text_calls: 0,
      image_jobs: 0,
      spend_usd: 0,
      faults: { text: ZERO_FAULTS, image_submit: ZERO_FAULTS },
    });
  });

  it('rounds spend to 6 decimals', async () => {
    build();

    for (let i = 0; i < 3; i++) {
      await post('/v1/images', { prompt: 'p' });
    }

    expect((await counters()).spend_usd).toBe(0.12);
  });

  it('validates and applies a fault override', async () => {
    build();
    const invalid = [
      undefined,
      { rate: 1 },
      { kinds: ['500'] },
      { rate: 1.5, kinds: ['500'] },
      { rate: -0.1, kinds: ['500'] },
      { rate: 'often', kinds: ['500'] },
      { rate: 1, kinds: ['404'] },
      { rate: 1, kinds: 'all' },
    ];

    for (const payload of invalid) {
      expect((await post('/_admin/faults', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }

    expect((await post('/v1/text', { brief: BRIEF })).statusCode).toBe(200);

    const res = await post('/_admin/faults', { rate: 1, kinds: ['500', '500'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rate: 1, kinds: ['500'] });
    expect((await post('/v1/text', { brief: BRIEF })).statusCode).toBe(500);
    expect((await counters()).faults.text).toEqual({ ...ZERO_FAULTS, '500': 1 });
  });

  it('reset zeroes the counters, forgets jobs and restores the fault settings it was built with', async () => {
    build();
    await post('/v1/text', { brief: BRIEF });
    const { job_id } = (await post('/v1/images', { prompt: 'p' })).json();
    await post('/_admin/faults', { rate: 1, kinds: ['429'] });
    expect((await post('/v1/text', { brief: BRIEF })).statusCode).toBe(429);

    const reset = await post('/_admin/reset');
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });
    expect(await counters()).toEqual({
      text_calls: 0,
      image_jobs: 0,
      spend_usd: 0,
      faults: { text: ZERO_FAULTS, image_submit: ZERO_FAULTS },
    });
    expect((await app.inject(`/v1/images/${job_id}`)).statusCode).toBe(404);
    expect((await post('/v1/text', { brief: BRIEF })).statusCode).toBe(200);
  });

  it('answers the health check', async () => {
    build();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
