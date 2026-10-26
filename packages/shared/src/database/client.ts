import pg from 'pg';
import { createLogger } from '../utils/log.js';
import { SQL } from './queries.js';

// int8 (bigserial ids, lease_version, count(*)) arrives as a string by default; ours fit a number.
pg.types.setTypeParser(20, (v) => Number(v));

export type Database = pg.Pool;

export const STEPS = [
  'verify',
  'text',
  'image_submit',
  'image_fetch',
  'upload',
  'draft',
  'publish',
] as const;
export type Step = (typeof STEPS)[number];

// A claimed operation. Only rows claimed as 'running' are run; 'unknown' ones are reported.
export interface Operation {
  id: number;
  article_id: string;
  step: Step;
  status: 'running' | 'unknown';
  attempts: number;
  lease_version: number;
  provider_ref: string | null;
  created_at: Date;
}

// Another worker owns the operation now (its lease_version moved on). Roll back and stop.
export class LeaseLost extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLost';
  }
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  });

  // An idle client losing its connection must not crash the process; the next checkout reconnects.
  const log = createLogger('database');
  pool.on('error', (err) => log.error({ err }, 'idle database connection failed'));

  return pool;
}

export async function transaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  let broken: Error | undefined;

  // A checked-out client whose connection dies emits 'error'; unhandled, that would crash the
  // process. Record it instead: the pending query fails and the client is discarded on release.
  const onError = (err: Error) => {
    broken = err;
  };
  client.on('error', onError);

  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');

    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch((e: Error) => {
      broken = e;
    });

    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

export async function claim(
  db: pg.Pool,
  steps: readonly Step[],
  leaseSeconds: number,
  limit: number,
  maxAttempts: number,
): Promise<Operation[]> {
  const { rows } = await db.query<Operation>(SQL.CLAIM, [steps, leaseSeconds, limit, maxAttempts]);

  return rows;
}

export async function renew(db: pg.Pool, op: Operation, leaseSeconds: number): Promise<boolean> {
  const r = await db.query(SQL.RENEW, [op.id, op.lease_version, leaseSeconds]);

  return r.rowCount === 1;
}

// What a successful step commits besides its own status: usage, its output columns, the next row.
export interface Completion {
  usage?: object | null;
  write?: { sql: string; params: unknown[] };
  next?: { step: Step; providerRef?: string | null } | null;
}

// One transaction: COMPLETE, the step's columns, the next step's row. False: the lease was lost and
// nothing was written.
export async function complete(db: pg.Pool, op: Operation, c: Completion): Promise<boolean> {
  return transaction(db, async (client) => {
    const done = await client.query(SQL.COMPLETE, [op.id, op.lease_version, c.usage ?? null]);

    if (done.rowCount !== 1) {
      return false;
    }

    if (c.write) {
      await client.query(c.write.sql, c.write.params);
    }

    if (c.next) {
      await client.query(SQL.NEXT, [op.article_id, c.next.step, c.next.providerRef ?? null]);
    }

    return true;
  });
}

export async function retry(
  db: pg.Pool,
  op: Operation,
  delaySeconds: number,
  error: string,
): Promise<boolean> {
  const r = await db.query(SQL.RETRY, [op.id, op.lease_version, delaySeconds, error]);

  return r.rowCount === 1;
}

export async function defer(db: pg.Pool, op: Operation, until: Date): Promise<boolean> {
  const r = await db.query(SQL.DEFER, [op.id, op.lease_version, until]);

  return r.rowCount === 1;
}

// FAIL, and on an auth error mark the site in the same transaction.
export async function fail(
  db: pg.Pool,
  op: Operation,
  error: string,
  authFailedSiteId?: string,
  expectedToken?: Buffer,
): Promise<boolean> {
  return transaction(db, async (client) => {
    const r = await client.query(SQL.FAIL, [op.id, op.lease_version, error]);

    if (r.rowCount !== 1) {
      return false;
    }

    if (authFailedSiteId) {
      await client.query(SQL.SITE_AUTH_FAILED, [authFailedSiteId, expectedToken ?? null]);
    }

    return true;
  });
}
