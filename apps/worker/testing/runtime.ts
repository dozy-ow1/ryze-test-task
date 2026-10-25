import { randomUUID } from 'node:crypto';
import { claim, createLogger, type Database, encryptToken, type Operation, SQL, STEPS, type Step } from '@ryze/core';
import pLimit from 'p-limit';
import type { Runner, StepFn } from '../src/runtime/types.js';

export const KEY = Buffer.alloc(32, 1).toString('base64');

export function createRunner(
  db: Database,
  steps: Partial<Record<Step, StepFn<unknown>>> = {},
  leaseSeconds = 30,
) {
  const ok: StepFn<unknown> = async () => ({});

  return {
    db,
    log: createLogger('test', 'silent'),
    steps: {
      ...(Object.fromEntries(STEPS.map((s) => [s, ok])) as Record<Step, StepFn<unknown>>),

      image_submit: async () => ({ providerRef: 'job-1' }),
      ...steps,
    },
    clients: {},
    siteTokenKey: KEY,
    leaseSeconds,
    maxAttempts: 8,
    imageKind: 'async',
    imageLimit: pLimit(4),
  } satisfies Runner<unknown>;
}

export async function seed(db: Database, n: number): Promise<{ siteId: string; ids: string[] }> {
  const { rows } = await db.query(
    `INSERT INTO sites (platform, base_url, token_enc) VALUES ('wordpress', 'http://wp', $1) RETURNING id`,
    [encryptToken('tok', KEY)],
  );

  const siteId = rows[0].id;
  const keys = Array.from({ length: n }, () => randomUUID());

  const inserted = await db.query(SQL.BULK_INTAKE, [
    keys.map(() => siteId),
    keys,
    keys.map(() => 'brief'),
  ]);

  const ids = inserted.rows.map((r) => r.id);
  await db.query(SQL.BULK_INTAKE_OPS, [ids]);

  return { siteId, ids };
}

// A claimed operation of the given step, as a worker would hold it.
export async function claimed(db: Database, step: Step, leaseSeconds = 30): Promise<Operation> {
  const { ids } = await seed(db, 1);
  await db.query(`UPDATE operations SET step = $2 WHERE article_id = $1`, [ids[0], step]);
  const pool = ['upload', 'draft', 'publish'].includes(step) ? 'publish' : 'generate';
  const steps: Step[] = pool === 'publish' ? ['upload', 'draft', 'publish'] : [step];

  const [op] = await claim(db, steps, leaseSeconds, 1, 8);

  return op;
}

export const state = async (db: Database, op: Operation) =>
  (
    await db.query(
      `SELECT status, attempts, last_error, EXTRACT(EPOCH FROM due_at - now())::float8 AS due_in
       FROM operations WHERE id = $1`,
      [op.id],
    )
  ).rows[0];
