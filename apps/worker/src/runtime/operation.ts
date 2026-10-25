import { classify, complete, type Deferred, decryptToken, defer, fail, isAuthError, LeaseLost, type Operation, Permanent, retry, type Step } from '@ryze/core';
import { keepLease } from './lease.js';
import type { Runner, StepContext } from './types.js';
import { nextStep } from './workflow.js';

const IMAGE_STEPS = new Set<Step>(['image_submit', 'image_fetch']);
const PLATFORM_STEPS = new Set<Step>(['verify', 'upload', 'draft', 'publish']);

// Seconds before retry n+1: min(1 h, 30 s * 2^n) plus up to 30 % jitter.
export function backoff(attempts: number, random = Math.random): number {
  const base = Math.min(3600, 30 * 2 ** attempts);

  return base + base * 0.3 * random();
}

const LOAD = `
  SELECT a.id, a.site_id, a.brief, a.title, a.slug, a.body_html, a.image_prompt,
         a.remote_media_id, a.remote_post_id,
         s.platform, s.base_url, s.token_enc, s.status AS site_status, s.verified_at
  FROM articles a JOIN sites s ON s.id = a.site_id
  WHERE a.id = $1`;

export async function runOperation<C>(r: Runner<C>, op: Operation): Promise<string> {
  const log = r.log.child({
    article_id: op.article_id,
    op_id: op.id,
    step: op.step,
    attempt: op.attempts + 1,
  });

  const started = Date.now();
  log.info('step start');
  const lease = new AbortController();
  const stopRenewing = keepLease(r.db, op, r.leaseSeconds, lease, log);
  let siteId: string | undefined;
  let siteToken: Buffer | undefined;
  let outcome: string;
  let errorClass: string | undefined;

  try {
    const { rows } = await r.db.query(LOAD, [op.article_id]);

    const row = rows[0];
    siteId = row.site_id;
    siteToken = row.token_enc;

    if (row.site_status !== 'active') {
      throw new Permanent(`site is ${row.site_status}`);
    }

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
        tokenVersion: row.token_enc,
      },
      clients: r.clients,
      log,
      signal: lease.signal,
    };

    const run = () => {
      // An image step may have waited for IMAGE_CONCURRENCY past its lease: then it must not call.
      if (lease.signal.aborted) {
        throw new LeaseLost();
      }

      return r.steps[op.step](ctx);
    };

    const result = IMAGE_STEPS.has(op.step) ? await r.imageLimit(run) : await run();

    if (lease.signal.aborted) {
      throw new LeaseLost();
    }

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
      outcome = await settle(r, op, err, errorClass, siteId, siteToken);
    }
  } finally {
    stopRenewing();
  }

  if (outcome === 'lost_lease') {
    log.warn('lost lease: another worker owns this operation');
  }

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
  siteToken: Buffer | undefined,
): Promise<string> {
  const message = describe(err);

  if (kind === 'deferred') {
    return (await defer(r.db, op, (err as Deferred).until)) ? 'deferred' : 'lost_lease';
  }

  if (kind === 'transient' && op.attempts + 1 < r.maxAttempts) {
    return (await retry(r.db, op, backoff(op.attempts), message)) ? 'retry' : 'lost_lease';
  }

  const authSite = PLATFORM_STEPS.has(op.step) && isAuthError(err) ? siteId : undefined;

  return (await fail(r.db, op, message, authSite, siteToken)) ? 'failed' : 'lost_lease';
}

// A short error description for logs and last_error. Never includes tokens or article bodies.
export function describe(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500);
}
