import { HttpError } from './http.js';

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
