import { createPool } from '@ryze/shared/database/client';
import { SQL } from '@ryze/shared/database/queries';
import { decryptToken } from '@ryze/shared/utils/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../../packages/shared/src/testing/database.js';
import { buildApp } from './app.js';
import { isDbUnavailable } from './utils/errors.js';

const TOKEN = JSON.stringify({
  clientId: 'client',
  clientSecret: 'tok-secret',
  blogId: 'gid://shopify/Blog/1',
});

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

async function site(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/sites',
    payload: {
      platform: 'shopify',
      base_url: 'https://test-store.myshopify.com',
      token: TOKEN,
    },
  });
  expect(res.statusCode).toBe(201);

  return res.json().id;
}

const count = async (sql: string, params: unknown[] = []) =>
  (await t.db.query<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, params)).rows[0].n;

describe('POST /sites', () => {
  it('stores the token encrypted and creates the site quota with publishing defaults', async () => {
    const id = await site();

    const { rows } = await t.db.query('SELECT token_enc, status FROM sites WHERE id = $1', [id]);
    expect(rows[0].status).toBe('active');
    expect(rows[0].token_enc.includes(Buffer.from('tok-secret'))).toBe(false);
    expect(decryptToken(rows[0].token_enc, KEY)).toBe(TOKEN);
    const quota = await t.db.query('SELECT capacity, refill, tokens FROM quotas WHERE scope = $1', [
      `site:${id}`,
    ]);
    expect(quota.rows[0]).toEqual({ capacity: 4, refill: 2, tokens: 4 });
  });

  it('registers Shopify credentials encrypted and validates the store root', async () => {
    const token = JSON.stringify({
      clientId: 'client',
      clientSecret: 'secret',
      blogId: 'gid://shopify/Blog/123',
    });

    const payload = { platform: 'shopify', base_url: 'https://test-store.myshopify.com', token };

    const response = await app.inject({ method: 'POST', url: '/sites', payload });
    expect(response.statusCode).toBe(201);
    const { rows } = await t.db.query('SELECT platform, token_enc FROM sites WHERE id = $1', [
      response.json().id,
    ]);
    expect(rows[0].platform).toBe('shopify');
    expect(decryptToken(rows[0].token_enc, KEY)).toBe(token);

    for (const base_url of [
      'http://test-store.myshopify.com',
      'https://attacker.example',
      'https://test-store.myshopify.com/admin',
      'https://test-store.myshopify.com.attacker.example',
    ]) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/sites',
        payload: { ...payload, base_url },
      });
      expect(rejected.statusCode).toBe(400);
    }

    const malformed = await app.inject({
      method: 'POST',
      url: '/sites',
      payload: { ...payload, token: 'plain-secret' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('rejects unsupported platforms', async () => {
    for (const platform of ['wordpress', 'wix', 'ghost']) {
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        payload: { platform, base_url: 'https://test-store.myshopify.com', token: TOKEN },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('POST /articles', () => {
  it('rejects empty or oversized paid briefs before enqueueing work', async () => {
    const siteId = await site();

    for (const brief of ['   ', 'x'.repeat(10_001)]) {
      const response = await app.inject({
        method: 'POST',
        url: '/articles',
        payload: { site_id: siteId, brief, idempotency_key: 'invalid-brief' },
      });
      expect(response.statusCode).toBe(400);
    }

    expect(await count('articles WHERE site_id = $1', [siteId])).toBe(0);
  });

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
      (client as any).query = (...args: unknown[]) => {
        if (args[0] !== SQL.INTAKE_OP) {
          return query(...args);
        }

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

describe('review fixes', () => {
  it('accepts an uppercase site id', async () => {
    const siteId = (await site()).toUpperCase();

    const one = await app.inject({
      method: 'POST',
      url: '/articles',
      payload: { site_id: siteId, brief: 'b', idempotency_key: 'upper-1' },
    });
    expect(one.statusCode).toBe(202);
    const bulk = await app.inject({
      method: 'POST',
      url: '/articles/bulk',
      payload: { items: [{ site_id: siteId, brief: 'b', idempotency_key: 'upper-2' }] },
    });
    expect(bulk.json().results[0].article_id).toEqual(expect.any(String));
  });

  it('answers a repeated key with its article even after the site was disabled', async () => {
    const siteId = await site();

    const payload = { site_id: siteId, brief: 'b', idempotency_key: 'disabled-later' };

    const first = await app.inject({ method: 'POST', url: '/articles', payload });
    await t.db.query(`UPDATE sites SET status = 'auth_failed' WHERE id = $1`, [siteId]);
    const again = await app.inject({ method: 'POST', url: '/articles', payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().article_id).toBe(first.json().article_id);
  });

  it('does not deadlock two bulk requests with the same keys in opposite orders', async () => {
    const siteId = await site();

    for (let round = 0; round < 10; round++) {
      const items = Array.from({ length: 50 }, (_, n) => ({
        site_id: siteId,
        brief: 'b',
        idempotency_key: `race-${round}-${n}`,
      }));

      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/articles/bulk', payload: { items } }),
        app.inject({
          method: 'POST',
          url: '/articles/bulk',
          payload: { items: [...items].reverse() },
        }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      const ids = (r: typeof a) =>
        r.json().results.map((x: { article_id: string }) => x.article_id);
      expect(ids(b)).toEqual([...ids(a)].reverse());
    }
  });

  it('maps a client that lost its connection to 503', () => {
    const err = new Error('Client has encountered a connection error and is not queryable');
    expect(isDbUnavailable(err)).toBe(true);
    expect(isDbUnavailable(new Error('syntax error at or near'))).toBe(false);
  });
});

describe('site recovery and destination validation', () => {
  it('rejects non-HTTP roots, embedded credentials, query strings and fragments', async () => {
    for (const base_url of [
      'file:///etc/passwd',
      'ftp://example.com',
      'https://user:password@example.com',
      'http://example.com/admin#',
      'http://example.com/admin?redirect=1',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        payload: { platform: 'shopify', base_url, token: TOKEN },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('replaces encrypted credentials and resets site verification and circuit state', async () => {
    const id = await site();
    await t.db.query(`UPDATE sites SET status = 'auth_failed', verified_at = now() WHERE id = $1`, [
      id,
    ]);
    await t.db.query(
      `UPDATE quotas SET failures = 5, open_until = now() + interval '1 minute' WHERE scope = $1`,
      [`site:${id}`],
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${id}`,
      payload: { token: TOKEN.replace('tok-secret', 'replacement') },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await t.db.query(
      'SELECT token_enc, status, verified_at FROM sites WHERE id = $1',
      [id],
    );
    expect(rows[0].status).toBe('active');
    expect(rows[0].verified_at).toBeNull();
    expect(decryptToken(rows[0].token_enc, KEY)).toBe(TOKEN.replace('tok-secret', 'replacement'));
    const quota = await t.db.query('SELECT failures, open_until FROM quotas WHERE scope = $1', [
      `site:${id}`,
    ]);
    expect(quota.rows[0]).toEqual({ failures: 0, open_until: null });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/sites/${crypto.randomUUID()}`,
          payload: { token: TOKEN.replace('tok-secret', 'replacement') },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('returns existing bulk articles on inactive sites but rejects new ones atomically', async () => {
    const site_id = await site();

    const item = { site_id, brief: 'existing', idempotency_key: 'inactive-bulk' };

    const first = await app.inject({
      method: 'POST',
      url: '/articles/bulk',
      payload: { items: [item] },
    });
    await t.db.query(`UPDATE sites SET status = 'auth_failed' WHERE id = $1`, [site_id]);
    const again = await app.inject({
      method: 'POST',
      url: '/articles/bulk',
      payload: { items: [item] },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json().results).toEqual([
      { article_id: first.json().results[0].article_id, created: false },
    ]);
    const mixed = await app.inject({
      method: 'POST',
      url: '/articles/bulk',
      payload: { items: [item, { ...item, idempotency_key: 'inactive-new' }] },
    });
    expect(mixed.statusCode).toBe(409);
    expect(await count('articles WHERE site_id = $1', [site_id])).toBe(1);
  });
});
