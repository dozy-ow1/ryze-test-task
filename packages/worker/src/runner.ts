import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Completion,
  claim,
  classify,
  complete,
  type Db,
  type Deferred,
  decryptToken,
  defer,
  fail,
  isAuthError,
  LeaseLost,
  type Logger,
  type Operation,
  Permanent,
  renew,
  retry,
  type Site,
  type Step,
} from '@ryze/core';
import pLimit, { type LimitFunction } from 'p-limit';

export const POOLS = {
  generate: ['verify', 'text', 'image_submit', 'image_fetch'],
  publish: ['upload', 'draft', 'publish'],
} as const satisfies Record<string, readonly Step[]>;
export type PoolName = keyof typeof POOLS;

const IMAGE_STEPS = new Set<Step>(['image_submit', 'image_fetch']);

export interface Article {
  id: string;
  site_id: string;
  brief: string;
  title: string | null;
  slug: string | null;
  body_html: string | null;
  image_prompt: string | null;
  remote_media_id: string | null;
  remote_post_id: string | null;
}

export interface StepContext<C> {
  op: Operation;
  article: Article;
  site: Site & { verified_at: Date | null };
  clients: C;
  log: Logger;
  signal: AbortSignal; // aborted when the lease is lost
}

// What a step hands back for COMPLETE: its usage, its own columns, and the job id the next row
// carries (image_submit only). The runner picks the next step.
export type StepResult = Pick<Completion, 'usage' | 'write'> & { providerRef?: string };
export type StepFn<C> = (ctx: StepContext<C>) => Promise<StepResult>;

export interface Runner<C> {
  db: Db;
  log: Logger;
  steps: Record<Step, StepFn<C>>;
  clients: C;
  siteTokenKey: string;
  leaseSeconds: number;
  maxAttempts: number;
  imageKind: 'async' | 'sync'; // a sync image provider has no image_submit step
  imageLimit: LimitFunction;
}

export function nextStep(step: Step, imageKind: 'async' | 'sync'): Step | null {
  switch (step) {
    case 'verify':
      return 'text';
    case 'text':
      return imageKind === 'sync' ? 'image_fetch' : 'image_submit';
    case 'image_submit':
      return 'image_fetch';
    case 'image_fetch':
      return 'upload';
    case 'upload':
      return 'draft';
    case 'draft':
      return 'publish';
    case 'publish':
      return null;
  }
}

// Seconds before retry n+1: min(1 h, 30 s * 2^n) plus up to 30 % jitter.
export function backoff(attempts: number, random = Math.random): number {
  const base = Math.min(3600, 30 * 2 ** attempts);
  return base + base * 0.3 * random();
}

// Claims what it has room for, runs each claimed row, sleeps 250-500 ms, repeats. On stop it
// claims nothing more and waits up to one lease for the steps in flight.
export async function runPool<C>(
  r: Runner<C>,
  pool: PoolName,
  concurrency: number,
  stop: AbortSignal,
): Promise<void> {
  const limit = pLimit(concurrency);
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
        const task: Promise<void> = limit(() => runStep(r, op))
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

const LOAD = `
  SELECT a.id, a.site_id, a.brief, a.title, a.slug, a.body_html, a.image_prompt,
         a.remote_media_id, a.remote_post_id,
         s.platform, s.base_url, s.token_enc, s.status AS site_status, s.verified_at
  FROM articles a JOIN sites s ON s.id = a.site_id
  WHERE a.id = $1`;

export async function runStep<C>(r: Runner<C>, op: Operation): Promise<string> {
  const log = r.log.child({
    article_id: op.article_id,
    op_id: op.id,
    step: op.step,
    attempt: op.attempts + 1,
  });
  const started = Date.now();
  log.info('step start');
  const lease = new AbortController();
  const stopRenewing = keepLease(r, op, lease, log);
  let siteId: string | undefined;
  let outcome: string;
  let errorClass: string | undefined;
  try {
    const { rows } = await r.db.query(LOAD, [op.article_id]);
    const row = rows[0];
    siteId = row.site_id;
    if (row.site_status !== 'active') throw new Permanent(`site is ${row.site_status}`);
    const ctx: StepContext<C> = {
      op,
      article: {
        id: row.id,
        site_id: row.site_id,
        brief: row.brief,
        title: row.title,
        slug: row.slug,
        body_html: row.body_html,
        image_prompt: row.image_prompt,
        remote_media_id: row.remote_media_id,
        remote_post_id: row.remote_post_id,
      },
      site: {
        id: row.site_id,
        platform: row.platform,
        base_url: row.base_url,
        token: decryptToken(row.token_enc, r.siteTokenKey),
        verified_at: row.verified_at,
      },
      clients: r.clients,
      log,
      signal: lease.signal,
    };
    const run = () => r.steps[op.step](ctx);
    const result = IMAGE_STEPS.has(op.step) ? await r.imageLimit(run) : await run();
    if (lease.signal.aborted) throw new LeaseLost();
    const next = nextStep(op.step, r.imageKind);
    const done = await complete(r.db, op, {
      usage: result.usage,
      write: result.write,
      next: next && { step: next, providerRef: result.providerRef },
    });
    outcome = done ? 'succeeded' : 'lost_lease';
  } catch (err) {
    if (err instanceof LeaseLost || lease.signal.aborted) {
      outcome = 'lost_lease';
    } else {
      errorClass = classify(err);
      outcome = await settle(r, op, err, errorClass, siteId);
    }
  } finally {
    stopRenewing();
  }
  if (outcome === 'lost_lease') log.warn('lost lease: another worker owns this operation');
  log.info({ duration_ms: Date.now() - started, outcome, error_class: errorClass }, 'step end');
  return outcome;
}

// Writes the failure: DEFER (not an attempt), RETRY with backoff, or FAIL. Every write is fenced.
async function settle<C>(
  r: Runner<C>,
  op: Operation,
  err: unknown,
  kind: string,
  siteId: string | undefined,
): Promise<string> {
  const message = describe(err);
  if (kind === 'deferred') {
    return (await defer(r.db, op, (err as Deferred).until)) ? 'deferred' : 'lost_lease';
  }
  if (kind === 'transient' && op.attempts + 1 < r.maxAttempts) {
    return (await retry(r.db, op, backoff(op.attempts), message)) ? 'retry' : 'lost_lease';
  }
  const authSite = isAuthError(err) ? siteId : undefined;
  return (await fail(r.db, op, message, authSite)) ? 'failed' : 'lost_lease';
}

// RENEW every LEASE_SECONDS / 3 while the step runs; zero rows means the lease is gone: abort.
function keepLease<C>(r: Runner<C>, op: Operation, lease: AbortController, log: Logger) {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    try {
      const held = await renew(r.db, op, r.leaseSeconds);
      if (stopped) return;
      if (!held) {
        lease.abort(new LeaseLost());
        return;
      }
    } catch (err) {
      // A database hiccup: try again next tick. If the lease really ran out, RENEW will say so.
      log.warn({ err: describe(err) }, 'lease renewal failed');
    }
    if (!stopped) timer = setTimeout(tick, (r.leaseSeconds * 1000) / 3);
  };
  timer = setTimeout(tick, (r.leaseSeconds * 1000) / 3);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// A short error description for logs and last_error. Never includes tokens or article bodies.
export function describe(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500);
}
