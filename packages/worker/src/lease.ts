import { type Database, LeaseLost, type Logger, type Operation, renew } from '@ryze/core';

const RENEWALS_PER_LEASE = 3;

// A separate expiry timer also aborts a step when the renewal query itself hangs.
export function keepLease(
  db: Database,
  op: Operation,
  leaseSeconds: number,
  lease: AbortController,
  log: Logger,
) {
  const leaseMs = leaseSeconds * 1000;
  let stopped = false;
  let renewal: NodeJS.Timeout;
  let expiry = setTimeout(() => lease.abort(new LeaseLost()), leaseMs);
  const tick = async () => {
    const requestedAt = Date.now();
    try {
      const held = await renew(db, op, leaseSeconds);
      if (stopped || lease.signal.aborted) {
        return;
      }
      if (!held) {
        clearTimeout(expiry);
        lease.abort(new LeaseLost());
        return;
      }
      clearTimeout(expiry);
      const remaining = Math.max(0, leaseMs - (Date.now() - requestedAt));
      expiry = setTimeout(() => lease.abort(new LeaseLost()), remaining);
    } catch (err) {
      log.warn({ err }, 'lease renewal failed');
    }
    if (!stopped && !lease.signal.aborted) {
      renewal = setTimeout(tick, leaseMs / RENEWALS_PER_LEASE);
    }
  };
  renewal = setTimeout(tick, leaseMs / RENEWALS_PER_LEASE);
  return () => {
    stopped = true;
    clearTimeout(renewal);
    clearTimeout(expiry);
  };
}
