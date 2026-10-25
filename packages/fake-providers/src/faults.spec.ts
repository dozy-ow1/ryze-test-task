import { setTimeout as sleep } from 'node:timers/promises';
import { FAULT_KINDS, type FaultKind, IMAGE_PRICE_USD, llmCost } from '@ryze/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type Delays } from './app.js';
import { writeArticle } from './content.js';

// Over a real socket: inject() cannot show a held or dropped connection.

const BRIEF = 'Spring lawn care tips for first-time homeowners';
const FAST: Partial<Delays> = {
  textWorkMs: [5, 5],
  jobReadyMs: [0, 0],
  slowExtraMs: [150, 150],
  timeoutHoldMs: 300,
};
const ZERO_FAULTS = Object.fromEntries(FAULT_KINDS.map((kind) => [kind, 0]));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(rate: number, kinds: FaultKind[], delays: Partial<Delays> = {}) {
  app = buildApp({ faultRate: rate, faultKinds: kinds, delays: { ...FAST, ...delays } });
  return app.listen({ port: 0, host: '127.0.0.1' });
}

function post(url: string, body: object, signal?: AbortSignal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

interface Counters {
  text_calls: number;
  image_jobs: number;
  spend_usd: number;
  faults: Record<'text' | 'image_submit', Record<FaultKind, number>>;
}

async function counters(base: string) {
  const res = await fetch(`${base}/_admin/counters`);
  return (await res.json()) as Counters;
}

const PAID = [
  {
    path: '/v1/text',
    group: 'text',
    body: { brief: BRIEF },
    work: 'text_calls',
    cost: llmCost('fake', writeArticle(BRIEF).usage),
  },
  {
    path: '/v1/images',
    group: 'image_submit',
    body: { prompt: BRIEF },
    work: 'image_jobs',
    cost: IMAGE_PRICE_USD,
  },
];

describe.each(PAID)('POST $path at fault rate 1', ({ path, group, body, work, cost }) => {
  it('429: answers with Retry-After 2, does no work and costs nothing', async () => {
    const base = await start(1, ['429']);
    const res = await post(base + path, body);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(await counters(base)).toMatchObject({
      [work]: 0,
      spend_usd: 0,
      faults: { [group]: { ...ZERO_FAULTS, '429': 1 } },
    });
  });

  it('500: answers with an error, does no work and costs nothing', async () => {
    const base = await start(1, ['500']);
    const res = await post(base + path, body);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(await counters(base)).toMatchObject({
      [work]: 0,
      spend_usd: 0,
      faults: { [group]: { ...ZERO_FAULTS, '500': 1 } },
    });
  });

  it('timeout: never answers, so the client gives up; no work, nothing spent', async () => {
    const base = await start(1, ['timeout']);
    await expect(post(base + path, body, AbortSignal.timeout(100))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(await counters(base)).toMatchObject({
      [work]: 0,
      spend_usd: 0,
      faults: { [group]: { ...ZERO_FAULTS, timeout: 1 } },
    });
  });

  it('timeout: cuts the connection once the hold is over', async () => {
    const base = await start(1, ['timeout'], { timeoutHoldMs: 100 });
    const started = Date.now();
    await expect(post(base + path, body)).rejects.toThrow('fetch failed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(await counters(base)).toMatchObject({ [work]: 0, spend_usd: 0 });
  });

  it('slow: answers normally after the extra delay, and the work is paid for', async () => {
    const base = await start(1, ['slow']);
    const started = Date.now();
    const res = await post(base + path, body);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(await counters(base)).toMatchObject({
      [work]: 1,
      spend_usd: cost,
      faults: { [group]: { ...ZERO_FAULTS, slow: 1 } },
    });
  });

  it('complete_then_drop: the client gets no answer, but the work is done and paid for', async () => {
    const base = await start(1, ['complete_then_drop']);
    await expect(post(base + path, body)).rejects.toThrow('fetch failed');
    expect(await counters(base)).toMatchObject({
      [work]: 1,
      spend_usd: cost,
      faults: { [group]: { ...ZERO_FAULTS, complete_then_drop: 1 } },
    });
  });
});

it('never faults polls, downloads, admin or health routes', async () => {
  const base = await start(0, []);
  const submit = await post(`${base}/v1/images`, { prompt: 'p' });
  const { job_id } = (await submit.json()) as { job_id: string };
  await post(`${base}/_admin/faults`, { rate: 1, kinds: FAULT_KINDS });

  const urls = [
    `/v1/images/${job_id}`,
    `/v1/images/${job_id}/file`,
    '/healthz',
    '/_admin/counters',
  ];
  for (let i = 0; i < 5; i++) {
    for (const url of urls) {
      const res = await fetch(base + url);
      await res.arrayBuffer();
      expect(res.status, url).toBe(200);
    }
  }
  expect((await counters(base)).faults).toEqual({ text: ZERO_FAULTS, image_submit: ZERO_FAULTS });
});

it('counts text work that completes after the client has gone away', async () => {
  const base = await start(0, [], { textWorkMs: [200, 200] });
  await expect(
    post(`${base}/v1/text`, { brief: BRIEF }, AbortSignal.timeout(50)),
  ).rejects.toThrow();
  expect((await counters(base)).text_calls).toBe(0);

  await vi.waitFor(async () => expect((await counters(base)).text_calls).toBe(1), {
    timeout: 2000,
    interval: 25,
  });
  expect((await counters(base)).spend_usd).toBe(llmCost('fake', writeArticle(BRIEF).usage));
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
});

it('closes promptly while a socket is held and a call is mid-work', async () => {
  const base = await start(1, ['timeout'], { textWorkMs: [1000, 1000], timeoutHoldMs: 40_000 });
  const held = post(`${base}/v1/text`, { brief: BRIEF }).catch((err: unknown) => err);
  await vi.waitFor(async () => expect((await counters(base)).faults.text.timeout).toBe(1));
  await post(`${base}/_admin/faults`, { rate: 0, kinds: [] });
  const working = post(`${base}/v1/text`, { brief: BRIEF }).catch((err: unknown) => err);
  await sleep(50);

  const started = Date.now();
  await app?.close();
  app = undefined;
  expect(Date.now() - started).toBeLessThan(500);
  expect(await held).toBeInstanceOf(TypeError);
  expect(await working).toBeInstanceOf(TypeError);
});
