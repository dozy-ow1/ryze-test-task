import { createPool, decryptToken, SQL } from '@ryze/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../../test/support/db.js';
import { buildApp } from '../src/app.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
let t: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  t = await testDb();
  app = buildApp({ db: t.db, siteTokenKey: KEY, logLevel: 'silent' });
});
afterAll(async () => {
  await app.close();
  await t.drop();
});

async function site(platform = 'wordpress'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/sites',
    payload: { platform, base_url: 'http://fake-platforms:8092/wordpress', token: 'tok-secret' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

const count = async (sql: string, params: unknown[] = []) =>
  (await t.db.query<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, params)).rows[0].n;

describe('POST /sites', () => {
  it('stores the token encrypted and creates the site quota with platform defaults', async () => {
    const id = await site('shopify');
    const { rows } = await t.db.query('SELECT token_enc, status FROM sites WHERE id = $1', [id]);
    expect(rows[0].status).toBe('active');
    expect(rows[0].token_enc.includes(Buffer.from('tok-secret'))).toBe(false);
    expect(decryptToken(rows[0].token_enc, KEY)).toBe('tok-secret');
    const quota = await t.db.query('SELECT capacity, refill, tokens FROM quotas WHERE scope = $1', [
      `site:${id}`,
    ]);
    expect(quota.rows[0]).toEqual({ capacity: 40, refill: 2, tokens: 40 });
  });

  it('rejects an unknown platform', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sites',
      payload: { platform: 'wix', base_url: 'http://x', token: 't' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /articles', () => {
  it('is idempotent on (site_id, idempotency_key)', async () => {
    const siteId = await site();
    const payload = { site_id: siteId, brief: 'Cold brew at home', idempotency_key: 'k-1' };
    const first = await app.inject({ method: 'POST', url: '/articles', payload });
    expect(first.statusCode).toBe(202);
    const again = await app.inject({
      method: 'POST',
      url: '/articles',
      payload: { ...payload, brief: 'a different brief' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().article_id).toBe(first.json().article_id);
    expect(await count('articles WHERE site_id = $1', [siteId])).toBe(1);
    expect(await count('operations WHERE article_id = $1', [first.json().article_id])).toBe(1);
    const op = await t.db.query('SELECT step, status FROM operations WHERE article_id = $1', [
      first.json().article_id,
    ]);
    expect(op.rows[0]).toEqual({ step: 'verify', status: 'pending' });
  });

  it('needs a known, active site', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: crypto.randomUUID(), brief: 'b', idempotency_key: 'k' },
    });
    expect(unknown.statusCode).toBe(404);
    const siteId = await site();
    await t.db.query(`UPDATE sites SET status = 'auth_failed' WHERE id = $1`, [siteId]);
    const inactive = await app.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: siteId, brief: 'b', idempotency_key: 'k' },
    });
    expect(inactive.statusCode).toBe(409);
  });
});

describe('POST /articles/bulk', () => {
  it('inserts in one transaction and reports per item', async () => {
    const siteId = await site();
    const items = Array.from({ length: 50 }, (_, n) => ({
      site_id: siteId,
      brief: `brief ${n}`,
      idempotency_key: `bulk-${n}`,
    }));
    const first = await app.inject({ method: 'POST', url: '/articles/bulk', payload: { items } });
    expect(first.statusCode).toBe(202);
    const created = first.json().results;
    expect(created).toHaveLength(50);
    expect(created.every((r: { created: boolean }) => r.created)).toBe(true);

    // The first 10 again plus a key repeated inside the batch.
    const next = [...items.slice(0, 10), { ...items[0] }, { ...items[49], idempotency_key: 'new' }];
    const second = await app.inject({
      method: 'POST',
      url: '/articles/bulk',
      payload: { items: next },
    });
    const results = second.json().results;
    expect(results.slice(0, 11).map((r: { article_id: string }) => r.article_id)).toEqual([
      ...created.slice(0, 10).map((r: { article_id: string }) => r.article_id),
      created[0].article_id,
    ]);
    expect(results.map((r: { created: boolean }) => r.created)).toEqual([
      ...Array(11).fill(false),
      true,
    ]);
    expect(await count('articles WHERE site_id = $1', [siteId])).toBe(51);
    expect(
      await count(
        `operations o JOIN articles a ON a.id = o.article_id WHERE a.site_id = $1 AND o.step = 'verify'`,
        [siteId],
      ),
    ).toBe(51);
  });

  it('caps a batch at 1000 items', async () => {
    const siteId = await site();
    const items = Array.from({ length: 1001 }, (_, n) => ({
      site_id: siteId,
      brief: 'b',
      idempotency_key: `cap-${n}`,
    }));
    const res = await app.inject({ method: 'POST', url: '/articles/bulk', payload: { items } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /articles', () => {
  it('returns the article with its operations, and a summary', async () => {
    const siteId = await site();
    const res = await app.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: siteId, brief: 'b', idempotency_key: 'get-1' },
    });
    const id = res.json().article_id;
    const got = await app.inject({ method: 'GET', url: `/articles/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().article.id).toBe(id);
    expect(got.json().operations).toEqual([
      expect.objectContaining({ step: 'verify', status: 'pending', attempts: 0, last_error: null }),
    ]);
    expect(
      (await app.inject({ method: 'GET', url: `/articles/${crypto.randomUUID()}` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/articles/not-a-uuid' })).statusCode).toBe(400);

    const summary = (await app.inject({ method: 'GET', url: '/articles/summary' })).json();
    expect(summary.operations.verify.pending).toBeGreaterThan(0);
    expect(summary.articles.published).toBe(0);
    expect(summary.articles.total).toBeGreaterThan(0);
  });
});

describe('POST /articles/:id/retry', () => {
  it('only re-runs a failed or unknown latest operation', async () => {
    const siteId = await site();
    const res = await app.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: siteId, brief: 'b', idempotency_key: 'retry-1' },
    });
    const id = res.json().article_id;
    expect((await app.inject({ method: 'POST', url: `/articles/${id}/retry` })).statusCode).toBe(
      409,
    );
    await t.db.query(
      `UPDATE operations SET status = 'failed', attempts = 8, last_error = 'HTTP 404' WHERE article_id = $1`,
      [id],
    );
    expect((await app.inject({ method: 'POST', url: `/articles/${id}/retry` })).statusCode).toBe(
      202,
    );
    const op = await t.db.query(
      'SELECT status, attempts, last_error FROM operations WHERE article_id = $1',
      [id],
    );
    expect(op.rows[0]).toEqual({ status: 'pending', attempts: 0, last_error: null });
    const unknown = await app.inject({
      method: 'POST',
      url: `/articles/${crypto.randomUUID()}/retry`,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('database unavailable', () => {
  it('answers 503 when Postgres cannot be reached', async () => {
    const down = createPool('postgres://ryze:ryze@127.0.0.1:1/ryze', 1);
    const offline = buildApp({ db: down, siteTokenKey: KEY, logLevel: 'silent' });
    const res = await offline.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: crypto.randomUUID(), brief: 'b', idempotency_key: 'k' },
    });
    expect(res.statusCode).toBe(503);
    expect((await offline.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await offline.close();
    await down.end();
  });

  it('leaves no partial rows when the connection dies mid-transaction', async () => {
    const siteId = await site();
    // Kill the backend of whichever connection is about to insert the article's first operation.
    const killer = createPool(t.url, 1);
    const flaky = createPool(t.url, 2);
    flaky.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      // biome-ignore lint/suspicious/noExplicitAny: pg's query() is heavily overloaded
      (client as any).query = (...args: unknown[]) => {
        if (args[0] !== SQL.INTAKE_OP) return query(...args);
        // biome-ignore lint/suspicious/noExplicitAny: processID is missing from the typings
        const pid = (client as any).processID;
        return killer.query('SELECT pg_terminate_backend($1)', [pid]).then(() => query(...args));
      };
    });
    const fragile = buildApp({ db: flaky, siteTokenKey: KEY, logLevel: 'silent' });
    const res = await fragile.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: siteId, brief: 'b', idempotency_key: 'half' },
    });
    expect(res.statusCode).toBe(503);
    expect(await count(`articles WHERE idempotency_key = 'half'`)).toBe(0);
    await fragile.close();
    await flaky.end();
    await killer.end();
  });
});
