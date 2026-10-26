import { Deferred, Permanent } from '../utils/errors.js';
import { HttpError } from '../utils/http.js';
import { createLogger } from '../utils/log.js';
import type { Database } from './client.js';
import { SQL } from './queries.js';

interface Take {
  allowed: boolean;
  open: boolean;
  open_until: Date | null;
  failures: number;
  capacity: number;
  wait_sec: number;
}

const log = createLogger('quota');

// Runs fn under the scope's token bucket and circuit breaker: one quotas row, shared by every
// worker. When it must not call, it throws Deferred instead of calling.
export async function withQuota<T>(
  db: Database,
  scope: string,
  units: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(units) || units <= 0) {
    throw new Permanent('quota units must be positive');
  }

  // The locked statement reserves both tokens and an expired breaker's single probe.
  const q = (await db.query<Take>(SQL.QUOTA_TAKE, [scope, units])).rows[0];

  if (!q) {
    throw new Permanent(`quota is not configured: ${scope}`);
  }

  if (units > q.capacity) {
    throw new Permanent(`requested units exceed quota capacity: ${scope}`);
  }

  if (q.open) {
    throw new Deferred(q.open_until as Date, `breaker open: ${scope}`);
  }

  if (!q.allowed) {
    throw new Deferred(new Date(Date.now() + q.wait_sec * 1000), `quota: ${scope}`);
  }

  try {
    const out = await fn();

    // Best effort: losing this write only delays closing the breaker, while throwing here would
    // turn a call that already succeeded (and was paid for) into a retry.
    if (q.failures > 0) {
      await db.query(SQL.BREAKER_RESET, [scope]).catch((err) => {
        log.warn({ err, scope }, 'could not reset circuit breaker after successful call');
      });
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
