import type { Database } from './database.js';
import { HttpError } from './platforms/http.js';
import { SQL } from './queries.js';

// The call has to wait (empty bucket, open breaker). Not an attempt: the operation is deferred.
export class Deferred extends Error {
  constructor(
    readonly until: Date,
    message: string,
  ) {
    super(message);
    this.name = 'Deferred';
  }
}

// A failure that no retry can fix. HTTP 4xx (other than 429) is permanent as well.
export class Permanent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Permanent';
  }
}

export type ErrorClass = 'deferred' | 'transient' | 'permanent';

export function classify(err: unknown): ErrorClass {
  if (err instanceof Deferred) {
    return 'deferred';
  }
  if (err instanceof Permanent) {
    return 'permanent';
  }
  if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
    return 'permanent';
  }
  return 'transient'; // 429, 5xx, timeouts, dropped connections and anything unknown
}

export function isAuthError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 401 || err.status === 403);
}

interface Take {
  allowed: boolean;
  open: boolean;
  open_until: Date | null;
  failures: number;
  wait_sec: number;
}

// Runs fn under the scope's token bucket and circuit breaker: one quotas row, shared by every
// worker. When it must not call, it throws Deferred instead of calling.
export async function withQuota<T>(
  db: Database,
  scope: string,
  units: number,
  fn: () => Promise<T>,
): Promise<T> {
  // An open breaker whose 30 s are over lets exactly one caller through: the half-open probe.
  const probe = (await db.query(SQL.BREAKER_PROBE, [scope])).rowCount === 1;
  let failures = 0;
  if (!probe) {
    const q = (await db.query<Take>(SQL.QUOTA_TAKE, [scope, units])).rows[0];
    if (q?.open) {
      throw new Deferred(q.open_until as Date, `breaker open: ${scope}`);
    }
    if (q && !q.allowed) {
      throw new Deferred(new Date(Date.now() + q.wait_sec * 1000), `quota: ${scope}`);
    }
    failures = q?.failures ?? 0;
  }
  try {
    const out = await fn();
    // Best effort: losing this write only delays closing the breaker, while throwing here would
    // turn a call that already succeeded (and was paid for) into a retry.
    if (probe || failures > 0) {
      await db.query(SQL.BREAKER_RESET, [scope]).catch(() => {});
    }
    return out;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      await db.query(SQL.QUOTA_DRAIN, [scope, err.retryAfter ?? 1]);
    } else if (err instanceof HttpError && (err.status === 0 || err.status >= 500)) {
      await db.query(SQL.BREAKER_FAILURE, [scope]);
    }
    throw err;
  }
}
