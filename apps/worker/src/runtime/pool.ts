import { setTimeout as sleep } from 'node:timers/promises';
import { claim, type Operation } from '@ryze/shared';
import { describe, runOperation } from './operation.js';
import type { Runner } from './types.js';
import { POOLS, type PoolName } from './workflow.js';

// Claims what it has room for, runs each claimed row, sleeps 250-500 ms, repeats. On stop it
// claims nothing more and waits up to one lease for the steps in flight.
export async function runPool<C>(
  r: Runner<C>,
  pool: PoolName,
  concurrency: number,
  stop: AbortSignal,
): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  while (!stop.aborted) {
    const free = concurrency - inFlight.size;

    if (free > 0) {
      let ops: Operation[] = [];

      try {
        ops = await claim(r.db, POOLS[pool], r.leaseSeconds, free, r.maxAttempts);
      } catch (err) {
        r.log.error({ err: describe(err) }, 'claim failed');
      }

      for (const op of ops) {
        if (op.status !== 'running') {
          r.log.error(
            { article_id: op.article_id, op_id: op.id, step: op.step },
            'lease expired on the last attempt: outcome unknown',
          );
          continue;
        }

        const task: Promise<void> = runOperation(r, op)
          .then(
            () => {},
            (err) => r.log.error({ op_id: op.id, err: describe(err) }, 'step crashed'),
          )
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    }

    await sleep(250 + Math.random() * 250, undefined, { signal: stop }).catch(() => {});
  }

  r.log.info({ in_flight: inFlight.size }, 'stopping: waiting for steps in flight');
  await Promise.race([Promise.allSettled([...inFlight]), sleep(r.leaseSeconds * 1000)]);
}
