import { classify, createHttp, type Database, Deferred, HttpError, isAuthError, Permanent, SQL, withQuota } from '@ryze/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, testDb } from '../testing/database.js';

describe('classify', () => {
  it('maps every error onto deferred, transient or permanent', () => {
    expect(classify(new Deferred(new Date(), 'quota'))).toBe('deferred');
    expect(classify(new Permanent('bad'))).toBe('permanent');

    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classify(new HttpError(status, 'x'))).toBe('permanent');
    }

    for (const status of [0, 429, 500, 502, 503, 529]) {
      expect(classify(new HttpError(status, 'x'))).toBe('transient');
    }

    expect(classify(new TypeError('surprise'))).toBe('transient');
    expect(isAuthError(new HttpError(401, 'x'))).toBe(true);
    expect(isAuthError(new HttpError(404, 'x'))).toBe(false);
  });
});

describe('withQuota', () => {
  let t: TestDb;
  const scope = 'provider:test';

  const row = async () =>
    (await t.db.query('SELECT * FROM quotas WHERE scope = $1', [scope])).rows[0];

  beforeAll(async () => {
    t = await testDb();
  });
  afterAll(() => t.drop());
  beforeEach(async () => {
    await t.db.query('DELETE FROM quotas');
    await t.db.query(SQL.SITE_QUOTA, [scope, 2, 1]);
  });

  it('calls while the bucket has units, then defers without calling', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withQuota(t.db, scope, 1, fn)).toBe('ok');
    expect(await withQuota(t.db, scope, 1, fn)).toBe('ok');
    const err = await withQuota(t.db, scope, 1, fn).catch((e) => e);
    expect(err).toBeInstanceOf(Deferred);
    expect(err.until.getTime()).toBeGreaterThan(Date.now() + 500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs unmetered when the scope has no row', async () => {
    expect(await withQuota(t.db, 'site:unknown', 1, async () => 7)).toBe(7);
  });

  it('a 429 drains the bucket until Retry-After and rethrows', async () => {
    const limited = new HttpError(429, 'slow down', 5);
    await expect(withQuota(t.db, scope, 1, () => Promise.reject(limited))).rejects.toBe(limited);
    const err = await withQuota(t.db, scope, 1, async () => 'never').catch((e) => e);
    expect(err).toBeInstanceOf(Deferred);
    expect(err.until.getTime()).toBeGreaterThan(Date.now() + 4_500);
    expect((await row()).failures).toBe(0); // a 429 is not an outage
  });

  it('opens after five outage failures, probes once, closes on success', async () => {
    await t.db.query('UPDATE quotas SET capacity = 100, tokens = 100 WHERE scope = $1', [scope]);
    const down = () => Promise.reject(new HttpError(503, 'down'));

    for (let i = 0; i < 5; i++) {
      await withQuota(t.db, scope, 1, down).catch(() => {});
    }

    expect((await row()).failures).toBe(5);
    const fn = vi.fn(async () => 'up');

    const open = await withQuota(t.db, scope, 1, fn).catch((e) => e);
    expect(open).toBeInstanceOf(Deferred);
    expect(open.message).toContain('breaker open');
    expect(fn).not.toHaveBeenCalled();

    await t.db.query(`UPDATE quotas SET open_until = now() - interval '1 s' WHERE scope = $1`, [
      scope,
    ]);
    expect(await withQuota(t.db, scope, 1, fn)).toBe('up'); // the half-open probe
    expect(await row()).toMatchObject({ failures: 0, open_until: null });
  });

  it('does not count client errors as outages', async () => {
    const bad = () => Promise.reject(new HttpError(422, 'invalid'));
    await withQuota(t.db, scope, 1, bad).catch(() => {});
    expect((await row()).failures).toBe(0);
  });

  it('does not count lease cancellation as a provider outage', async () => {
    const controller = new AbortController();
    const reason = new Error('lease lost');
    controller.abort(reason);
    await expect(
      withQuota(t.db, scope, 1, () =>
        createHttp(1000)('https://example.com', { signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect((await row()).failures).toBe(0);
  });
});

describe('withQuota when the database stumbles after the call', () => {
  it('keeps a successful (paid) result if closing the breaker fails', async () => {
    const t = await testDb();

    try {
      await t.db.query(SQL.SITE_QUOTA, ['provider:paid', 10, 1]);
      await t.db.query(`UPDATE quotas SET failures = 3 WHERE scope = 'provider:paid'`);
      const flaky = {
        query: (sql: string, params?: unknown[]) =>
          sql === SQL.BREAKER_RESET
            ? Promise.reject(new Error('db hiccup'))
            : t.db.query(sql, params),
      } as unknown as Database;
      expect(await withQuota(flaky, 'provider:paid', 1, async () => 'paid')).toBe('paid');
    } finally {
      await t.drop();
    }
  });
});
