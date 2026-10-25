import { setTimeout as sleep } from 'node:timers/promises';
import { STEPS, type Step } from '@ryze/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../../../packages/core/testing/database.js';
import { createRunner, seed as seedArticles } from '../../testing/runtime.js';
import { runPool } from './pool.js';
import type { StepFn } from './types.js';
import type { PoolName } from './workflow.js';

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

const seed = (n: number) => seedArticles(t.db, n);

describe('runPool', () => {
  it('takes every article through all seven steps exactly once, with two workers per pool', async () => {
    const { ids } = await seed(100);

    const jitter: StepFn<unknown> = async () => {
      await sleep(Math.random() * 5);

      return {};
    };

    const steps = Object.fromEntries(STEPS.map((s) => [s, jitter])) as Record<
      Step,
      StepFn<unknown>
    >;
    steps.image_submit = async () => ({ providerRef: 'job-1' });
    const stop = new AbortController();
    const pools: PoolName[] = ['generate', 'generate', 'publish', 'publish'];
    const loops = pools.map((p) => runPool(runner(steps), p, 25, stop.signal));

    for (let i = 0; i < 200; i++) {
      const { rows } = await t.db.query(
        `SELECT count(*) AS n FROM operations WHERE step = 'publish' AND status = 'succeeded'`,
      );

      if (rows[0].n === ids.length) {
        break;
      }

      await sleep(100);
    }

    stop.abort();
    await Promise.all(loops);
    const { rows } = await t.db.query(
      `SELECT step, status, count(*) AS n FROM operations GROUP BY step, status ORDER BY step`,
    );
    expect(rows).toHaveLength(7);

    for (const r of rows) {
      expect(r).toMatchObject({ status: 'succeeded', n: 100 });
    }

    const refs = await t.db.query(
      `SELECT count(*) AS n FROM operations WHERE step = 'image_fetch' AND provider_ref = 'job-1'`,
    );
    expect(refs.rows[0].n).toBe(100);
  });
});
