import { setTimeout as sleep } from 'node:timers/promises';
import { claim, Deferred, encryptToken, HttpError, type Operation, Permanent, SQL, type Step } from '@ryze/shared';
import pLimit from 'p-limit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../../../packages/shared/src/testing/database.js';
import type { Clients } from '../infrastructure/clients.js';
import { imageFetch } from '../modules/generation/image-fetch.js';
import { verify } from '../modules/generation/verify.js';
import { upload } from '../modules/publishing/upload.js';
import { claimed as claimStep, createRunner, KEY, state as operationState } from '../testing/runtime.js';
import { backoff, runOperation } from './operation.js';
import type { Runner, StepFn } from './types.js';

let t: TestDb;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.drop());
beforeEach(async () => {
  await t.db.query('TRUNCATE operations, articles, sites, quotas RESTART IDENTITY CASCADE');
});

function runner(steps: Partial<Record<Step, StepFn<unknown>>> = {}, leaseSeconds = 30) {
  return createRunner(t.db, steps, leaseSeconds);
}

const claimed = (step: Step, leaseSeconds = 30) => claimStep(t.db, step, leaseSeconds);
const state = (op: Operation) => operationState(t.db, op);

describe('backoff', () => {
  it('is min(1 h, 30 s * 2^n) plus up to 30 % jitter', () => {
    expect(backoff(0, () => 0)).toBe(30);
    expect(backoff(0, () => 1)).toBe(39);
    expect(backoff(3, () => 0)).toBe(240);
    expect(backoff(20, () => 0)).toBe(3600);
    expect(backoff(20, () => 1)).toBe(4680);
  });
});

describe('runOperation', () => {
  it('does not cache old credential verification after credentials are replaced', async () => {
    const op = await claimed('verify');

    const r: Runner<Clients> = {
      ...runner(),
      steps: { ...runner().steps, verify },
      clients: {
        db: t.db,
        platform: {
          verify: async (site) => {
            await t.db.query('UPDATE sites SET token_enc = $2, verified_at = NULL WHERE id = $1', [
              site.id,
              encryptToken('replacement', KEY),
            ]);
          },
        },
      } as Clients,
    };
    expect(await runOperation(r, op)).toBe('succeeded');
    const { rows } = await t.db.query('SELECT verified_at FROM sites');
    expect(rows[0].verified_at).toBeNull();
  });

  it('returns a pending image to the queue and releases its concurrency slot', async () => {
    const op = await claimed('image_fetch');
    await t.db.query('UPDATE operations SET provider_ref = $2 WHERE id = $1', [
      op.id,
      'pending-image',
    ]);
    op.provider_ref = 'pending-image';
    const limit = pLimit(1);

    const r: Runner<Clients> = {
      ...runner(),
      steps: { ...runner().steps, image_fetch: imageFetch },
      clients: {
        store: { exists: async () => false },
        image: { kind: 'async', poll: async () => ({ status: 'pending' }) },
      } as unknown as Clients,
      imageLimit: limit,
    };
    expect(await runOperation(r, op)).toBe('deferred');
    expect(await state(op)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(limit.activeCount).toBe(0);
    expect(await limit(async () => 'next image can start')).toBe('next image can start');
  });

  it('retries a transient failure after the backoff', async () => {
    const op = await claimed('text');

    const r = runner({ text: () => Promise.reject(new HttpError(503, 'upstream down')) });
    expect(await runOperation(r, op)).toBe('retry');
    const s = await state(op);
    expect(s).toMatchObject({ status: 'pending', attempts: 1 });
    expect(s.last_error).toContain('upstream down');
    expect(s.due_in).toBeGreaterThan(29);
  });

  it('fails a transient failure on the last attempt', async () => {
    const op = await claimed('text');

    const last = { ...op, attempts: 7 };
    await t.db.query('UPDATE operations SET attempts = 7 WHERE id = $1', [op.id]);
    const r = runner({ text: () => Promise.reject(new HttpError(0, 'timeout')) });
    expect(await runOperation(r, last)).toBe('failed');
    expect(await state(op)).toMatchObject({ status: 'failed', attempts: 8 });
  });

  it('defers without counting an attempt', async () => {
    const op = await claimed('upload');

    const until = new Date(Date.now() + 2_000);
    const r = runner({ upload: () => Promise.reject(new Deferred(until, 'quota')) });
    expect(await runOperation(r, op)).toBe('deferred');
    const s = await state(op);
    expect(s).toMatchObject({ status: 'pending', attempts: 0 });
    expect(s.due_in).toBeGreaterThan(1);
  });

  it('fails permanently, and an auth error marks the site', async () => {
    const op = await claimed('draft');

    const r = runner({ draft: () => Promise.reject(new HttpError(401, 'bad token')) });
    expect(await runOperation(r, op)).toBe('failed');
    expect(await state(op)).toMatchObject({ status: 'failed' });
    const site = await t.db.query(
      'SELECT s.status FROM sites s JOIN articles a ON a.site_id = s.id WHERE a.id = $1',
      [op.article_id],
    );
    expect(site.rows[0].status).toBe('auth_failed');

    const other = await claimed('publish');
    await t.db.query(
      `UPDATE articles SET site_id = (SELECT site_id FROM articles WHERE id = $1) WHERE id = $2`,
      [op.article_id, other.article_id],
    );
    let called = false;

    const r2 = runner({
      publish: async () => {
        called = true;

        return {};
      },
    });
    expect(await runOperation(r2, other)).toBe('failed');
    expect(called).toBe(false);
    expect((await state(other)).last_error).toContain('auth_failed');

    const bad = await claimed('text');
    expect(
      await runOperation(runner({ text: () => Promise.reject(new Permanent('no')) }), bad),
    ).toBe('failed');
  });

  it.each(['text', 'image_submit', 'image_fetch'] as const)(
    'a %s provider authentication failure keeps the customer site active',
    async (step) => {
      const op = await claimed(step);

      const r = runner({
        [step]: async () => {
          throw new HttpError(401, 'provider key invalid');
        },
      });
      expect(await runOperation(r, op)).toBe('failed');
      const site = await t.db.query(
        'SELECT s.status FROM sites s JOIN articles a ON a.site_id = s.id WHERE a.id = $1',
        [op.article_id],
      );
      expect(site.rows[0].status).toBe('active');
    },
  );

  it('an old in-flight auth failure cannot disable newly rotated credentials', async () => {
    const op = await claimed('publish');

    const r = runner({
      publish: async (ctx) => {
        await t.db.query(
          "UPDATE sites SET token_enc = $2, status = 'active', verified_at = NULL WHERE id = $1",
          [ctx.site.id, encryptToken('replacement-token', KEY)],
        );

        throw new HttpError(401, 'old credentials rejected');
      },
    });
    expect(await runOperation(r, op)).toBe('failed');
    const site = await t.db.query(
      'SELECT s.status FROM sites s JOIN articles a ON a.site_id = s.id WHERE a.id = $1',
      [op.article_id],
    );
    expect(site.rows[0].status).toBe('active');
  });

  it('never starts an upload after renewal rejects ownership during its lookup', async () => {
    const op = await claimed('upload', 0.6);

    let writes = 0;

    const r = runner(
      {
        upload: async (ctx) => {
          const clients = {
            db: t.db,
            store: { get: async () => Buffer.from('cover') },
            platform: {
              findMedia: async () => {
                await t.db.query(
                  'UPDATE operations SET lease_version = lease_version + 1 WHERE id = $1',
                  [op.id],
                );

                if (!ctx.signal.aborted) {
                  await new Promise<void>((resolve) =>
                    ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
                  );
                }

                return null;
              },

              uploadMedia: async () => {
                writes++;

                return 'stale-media';
              },
            },
          } as unknown as Clients;

          return upload({ ...ctx, clients });
        },
      },
      0.6,
    );
    expect(await runOperation(r, op)).toBe('lost_lease');
    expect(writes).toBe(0);
  });

  it('writes nothing when another worker took the operation over', async () => {
    const op = await claimed('upload');

    const r = runner({
      upload: async () => {
        // Meanwhile the lease expired and another worker claimed the row.
        await t.db.query('UPDATE operations SET lease_version = lease_version + 1 WHERE id = $1', [
          op.id,
        ]);

        return { write: { sql: SQL.WRITE_MEDIA, params: [op.article_id, 'm-1'] } };
      },
    });
    expect(await runOperation(r, op)).toBe('lost_lease');
    const a = await t.db.query('SELECT remote_media_id FROM articles WHERE id = $1', [
      op.article_id,
    ]);
    expect(a.rows[0].remote_media_id).toBeNull();
    expect((await state(op)).status).toBe('running');
  });

  it('aborts before any new effect when a renewal query never answers', async () => {
    const op = await claimed('text', 0.3);

    let aborted = false;

    const r = runner(
      {
        text: async (ctx) => {
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          aborted = ctx.signal.aborted;

          return {};
        },
      },
      0.3,
    );

    const query = t.db.query.bind(t.db);
    r.db = {
      query: (sql: string, params: unknown[]) =>
        sql === SQL.RENEW ? new Promise(() => {}) : query(sql, params),
    } as unknown as Runner<unknown>['db'];
    expect(await runOperation(r, op)).toBe('lost_lease');
    expect(aborted).toBe(true);
  });

  it('renews the lease while a long step runs', async () => {
    const op = await claimed('image_fetch', 0.6);

    let stolen: Operation[] = [];

    const r = runner(
      {
        image_fetch: async () => {
          await sleep(1_500);
          stolen = await claim(t.db, ['image_fetch'], 0.6, 1, 8); // another worker tries

          return {};
        },
      },
      0.6,
    );
    expect(await runOperation(r, op)).toBe('succeeded');
    expect(stolen).toEqual([]);
  });

  it('aborts the step when a renewal finds the lease gone', async () => {
    const op = await claimed('image_fetch', 0.6);

    const r = runner(
      {
        image_fetch: async (ctx) => {
          await t.db.query(
            'UPDATE operations SET lease_version = lease_version + 1 WHERE id = $1',
            [op.id],
          );
          await sleep(2_000, undefined, { signal: ctx.signal }).catch(() => {});
          expect(ctx.signal.aborted).toBe(true);

          return {};
        },
      },
      0.6,
    );
    expect(await runOperation(r, op)).toBe('lost_lease');
  });
});

describe('a lease lost while waiting for an image slot', () => {
  it('never starts the paid call', async () => {
    const op = await claimed('image_submit', 0.6);

    const imageLimit = pLimit(1);
    let release = () => {};
    const blocker = imageLimit(() => new Promise<void>((done) => (release = done)));
    let called = false;

    const r = {
      ...runner(
        {
          image_submit: async () => {
            called = true;

            return { providerRef: 'job-2' };
          },
        },
        0.6,
      ),
      imageLimit,
    };

    const running = runOperation(r, op);
    // Meanwhile another worker takes the row over.
    await t.db.query('UPDATE operations SET lease_version = lease_version + 1 WHERE id = $1', [
      op.id,
    ]);
    await sleep(500); // a renewal (every 0.2 s) notices
    release();
    expect(await running).toBe('lost_lease');
    expect(called).toBe(false);
    await blocker;
  });
});
