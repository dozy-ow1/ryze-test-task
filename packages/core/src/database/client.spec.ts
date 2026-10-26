import { randomUUID } from 'node:crypto';
import { claim, complete, createPool, defer, fail, type Operation, renew, retry, SQL, type Step } from '@ryze/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../testing/database.js';

// Queue recovery and concurrency against real PostgreSQL, including two claimers racing.

const GENERATE: Step[] = ['verify', 'text', 'image_submit', 'image_fetch'];
const PUBLISH: Step[] = ['upload', 'draft', 'publish'];
let t: TestDb;
let siteId: string;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.drop());
beforeEach(async () => {
  await t.db.query('TRUNCATE operations, articles, sites, quotas RESTART IDENTITY CASCADE');
  const { rows } = await t.db.query(
    `INSERT INTO sites (platform, base_url, token_enc) VALUES ('shopify', 'https://test-store.myshopify.com', '\\x00') RETURNING id`,
  );
  siteId = rows[0].id;
});

async function article(): Promise<string> {
  const { rows } = await t.db.query(SQL.INTAKE, [siteId, randomUUID(), 'brief']);

  return rows[0].id;
}

async function op(step: Step, extra = ''): Promise<number> {
  const id = await article();

  const { rows } = await t.db.query(
    `INSERT INTO operations (article_id, step) VALUES ($1, $2) RETURNING id`,
    [id, step],
  );

  if (extra) {
    await t.db.query(`UPDATE operations SET ${extra} WHERE id = $1`, [rows[0].id]);
  }

  return rows[0].id;
}

const row = async (id: number) =>
  (
    await t.db.query(
      'SELECT *, EXTRACT(EPOCH FROM due_at - now())::float8 AS due_in FROM operations WHERE id = $1',
      [id],
    )
  ).rows[0];

const expire = (id: number) =>
  t.db.query(`UPDATE operations SET due_at = now() - interval '1 second' WHERE id = $1`, [id]);

describe('intake', () => {
  it('creates nothing for a repeated idempotency key', async () => {
    const first = await t.db.query(SQL.INTAKE, [siteId, 'k1', 'brief']);

    const again = await t.db.query(SQL.INTAKE, [siteId, 'k1', 'other brief']);
    expect(first.rowCount).toBe(1);
    expect(again.rowCount).toBe(0);
    const existing = await t.db.query(SQL.INTAKE_EXISTING, [siteId, 'k1']);
    expect(existing.rows[0].id).toBe(first.rows[0].id);
  });
});

describe('claim', () => {
  it('takes only due rows of its pool, and sets the lease', async () => {
    const verify = await op('verify');
    await op('upload');
    await op('text', `due_at = now() + interval '1 minute'`);
    const got = await claim(t.db, GENERATE, 120, 10, 8);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: verify, step: 'verify', status: 'running', attempts: 0 });
    expect(got[0].lease_version).toBe(1);
    const r = await row(verify);
    expect(r.due_in).toBeGreaterThan(119);
    expect(await claim(t.db, GENERATE, 120, 10, 8)).toHaveLength(0); // the live lease is held
  });

  it('never hands the same row to two concurrent claimers', async () => {
    const ids = new Set<number>();

    for (let i = 0; i < 200; i++) {
      ids.add(await op('upload'));
    }

    const a = createPool(t.url, 4);
    const b = createPool(t.url, 4);

    const drain = async (db: typeof a) => {
      const mine: number[] = [];

      for (;;) {
        const got = await claim(db, PUBLISH, 60, 7, 8);

        if (got.length === 0) {
          return mine;
        }

        mine.push(...got.map((o) => o.id));
      }
    };

    const [fromA, fromB] = await Promise.all([drain(a), drain(b)]);
    await Promise.all([a.end(), b.end()]);
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromB.length).toBeGreaterThan(0);
    expect(fromA.filter((id) => fromB.includes(id))).toEqual([]);
    expect(new Set([...fromA, ...fromB])).toEqual(ids);
  });
});

describe('guarded completion', () => {
  it('commits status, columns and the next row together, once, for the current lease', async () => {
    const id = await op('upload');

    const [claimed] = await claim(t.db, PUBLISH, 60, 1, 8);

    const write = { sql: SQL.WRITE_MEDIA, params: [claimed.article_id, 'media-1'] };
    const stale: Operation = { ...claimed, lease_version: claimed.lease_version - 1 };
    expect(await complete(t.db, stale, { write, next: { step: 'draft' } })).toBe(false);
    const media = () =>
      t.db.query('SELECT remote_media_id FROM articles WHERE id = $1', [claimed.article_id]);
    expect((await media()).rows[0].remote_media_id).toBeNull();

    expect(
      await complete(t.db, claimed, { usage: { calls: 1 }, write, next: { step: 'draft' } }),
    ).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'succeeded', usage: { calls: 1 } });
    expect((await media()).rows[0].remote_media_id).toBe('media-1');
    expect(await complete(t.db, claimed, { write, next: { step: 'draft' } })).toBe(false);
    const next = await t.db.query(
      `SELECT status FROM operations WHERE article_id = $1 AND step = 'draft'`,
      [claimed.article_id],
    );
    expect(next.rows).toEqual([{ status: 'pending' }]);
  });
});

describe('lease expiry', () => {
  it('reclaims an expired lease: attempts + 1, new lease, provider_ref kept', async () => {
    const id = await op('image_fetch', `provider_ref = 'job-1'`);

    const [first] = await claim(t.db, GENERATE, 120, 1, 8);
    await expire(id);
    const [second] = await claim(t.db, GENERATE, 120, 1, 8);
    expect(second).toMatchObject({ id, status: 'running', attempts: 1, provider_ref: 'job-1' });
    expect(second.lease_version).toBe(first.lease_version + 1);
    expect((await row(id)).last_error).toBe('lease expired');

    // The first worker's lease is fenced off everywhere.
    expect(await renew(t.db, first, 120)).toBe(false);
    expect(await retry(t.db, first, 30, 'late')).toBe(false);
    expect(await defer(t.db, first, new Date())).toBe(false);
    expect(await fail(t.db, first, 'late')).toBe(false);
    expect(await complete(t.db, first, {})).toBe(false);
    expect(await renew(t.db, second, 60)).toBe(true);
    expect((await row(id)).status).toBe('running');
  });

  it('turns an expired lease on the last attempt into unknown, which is never claimed', async () => {
    const id = await op('draft', `status = 'running', attempts = 7, lease_version = 7`);
    await expire(id);
    const [given] = await claim(t.db, PUBLISH, 60, 1, 8);
    expect(given).toMatchObject({ id, status: 'unknown', attempts: 8 });
    expect(await claim(t.db, PUBLISH, 60, 1, 8)).toHaveLength(0);
  });
});

describe('retry, defer, fail and the retry endpoint', () => {
  it('follow their semantics', async () => {
    const id = await op('image_fetch');

    let [o] = await claim(t.db, GENERATE, 120, 1, 8);

    const until = new Date(Date.now() + 5_000);
    expect(await defer(t.db, o, until)).toBe(true);
    let r = await row(id);
    expect(r).toMatchObject({ status: 'pending', attempts: 0 });
    expect(r.due_at.getTime()).toBe(until.getTime());

    await t.db.query('UPDATE operations SET due_at = now() WHERE id = $1', [id]);
    [o] = await claim(t.db, GENERATE, 120, 1, 8);
    expect(await retry(t.db, o, 30, 'HTTP 503')).toBe(true);
    r = await row(id);
    expect(r).toMatchObject({ status: 'pending', attempts: 1, last_error: 'HTTP 503' });
    expect(r.due_in).toBeGreaterThan(29);

    await t.db.query('UPDATE operations SET due_at = now() WHERE id = $1', [id]);
    [o] = await claim(t.db, GENERATE, 120, 1, 8);
    expect(await fail(t.db, o, 'HTTP 404', siteId)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'failed', last_error: 'HTTP 404', attempts: 2 });
    const site = await t.db.query('SELECT status FROM sites WHERE id = $1', [siteId]);
    expect(site.rows[0].status).toBe('auth_failed');

    const again = await t.db.query(SQL.RETRY_ARTICLE, [o.article_id]);
    expect(again.rows).toEqual([{ id }]);
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect((await t.db.query(SQL.RETRY_ARTICLE, [o.article_id])).rowCount).toBe(0);
  });
});

describe('quota and breaker statements', () => {
  const take = async (scope: string, units: number) =>
    (await t.db.query(SQL.QUOTA_TAKE, [scope, units])).rows[0];

  const quota = async (scope: string) =>
    (await t.db.query('SELECT * FROM quotas WHERE scope = $1', [scope])).rows[0];

  it('take, wait, refill, drain', async () => {
    await t.db.query(SQL.SITE_QUOTA, ['site:x', 4, 2]);
    expect((await take('site:x', 4)).allowed).toBe(true);
    const empty = await take('site:x', 1);
    expect(empty.allowed).toBe(false);
    expect(empty.wait_sec).toBeGreaterThan(0.45);
    expect(empty.wait_sec).toBeLessThanOrEqual(0.5);
    await t.db.query(
      `UPDATE quotas SET tokens_at = now() - interval '1 second' WHERE scope = 'site:x'`,
    );
    expect((await take('site:x', 1)).allowed).toBe(true);
    expect((await quota('site:x')).tokens).toBeCloseTo(1, 1);
    await t.db.query(SQL.QUOTA_DRAIN, ['site:x', 2]);
    const drained = await take('site:x', 1);
    expect(drained.allowed).toBe(false);
    expect(drained.wait_sec).toBeGreaterThan(2.4);
  });

  it('breaker: opens on the fifth failure, lets one probe through, closes on success', async () => {
    await t.db.query(SQL.SITE_QUOTA, ['provider:x', 10, 2]);

    for (let i = 0; i < 4; i++) {
      await t.db.query(SQL.BREAKER_FAILURE, ['provider:x']);
    }

    expect((await quota('provider:x')).open_until).toBeNull();
    await t.db.query(SQL.BREAKER_FAILURE, ['provider:x']);
    const refused = await take('provider:x', 1);
    expect(refused).toMatchObject({ allowed: false, open: true });
    expect((await t.db.query(SQL.BREAKER_PROBE, ['provider:x'])).rowCount).toBe(0);
    await t.db.query(
      `UPDATE quotas SET open_until = now() - interval '1 s' WHERE scope = 'provider:x'`,
    );
    expect((await t.db.query(SQL.BREAKER_PROBE, ['provider:x'])).rowCount).toBe(1);
    expect((await t.db.query(SQL.BREAKER_PROBE, ['provider:x'])).rowCount).toBe(0);
    await t.db.query(SQL.BREAKER_RESET, ['provider:x']);
    expect(await take('provider:x', 1)).toMatchObject({ allowed: true, open: false, failures: 0 });
  });
});
