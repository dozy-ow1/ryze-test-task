import { setTimeout as sleep } from 'node:timers/promises';
import { imageUsage, Permanent, withQuota } from '@ryze/core';
import sharp from 'sharp';
import type { Clients } from '../clients.js';
import type { StepContext, StepFn } from '../runner.js';
import { coverKey } from '../store.js';

const POLL_EVERY_MS = 1_000;
const POLL_FOR_MS = 120_000;

// The cover's key is fixed by the article id: if an earlier attempt stored it, nothing is paid
// again. Otherwise wait for the job (async provider) or generate (sync), crop and store.
export const imageFetch: StepFn<Clients> = async (ctx) => {
  const { article, clients, signal } = ctx;
  signal.throwIfAborted();
  const key = coverKey(article.id);

  if (await clients.store.exists(key, signal)) {
    return { usage: imageUsage(clients.image.model) };
  }

  signal.throwIfAborted();

  const raw =
    clients.image.kind === 'sync'
      ? await generate(ctx)
      : await waitForJob(ctx, ctx.op.provider_ref);
  signal.throwIfAborted();
  const cover = await sharp(raw)
    .resize(1200, 630, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();
  signal.throwIfAborted();
  await clients.store.put(key, cover, signal);

  return { usage: imageUsage(clients.image.model) };
};

async function generate({ article, clients, signal }: StepContext<Clients>): Promise<Buffer> {
  const gen = clients.image.generate;

  if (!gen) {
    throw new Permanent('the image provider cannot generate synchronously');
  }

  const prompt = article.image_prompt ?? article.brief;

  return withQuota(clients.db, 'provider:image', 1, () => {
    signal.throwIfAborted();

    return gen(prompt, signal);
  });
}

// Polling is free, so it is not metered. A job the provider does not know (404) is permanent.
async function waitForJob(
  { clients, signal }: StepContext<Clients>,
  jobId: string | null,
): Promise<Buffer> {
  const poll = clients.image.poll;

  if (!poll || !jobId) {
    throw new Permanent('no image job to wait for');
  }

  const deadline = Date.now() + POLL_FOR_MS;

  for (;;) {
    signal.throwIfAborted();
    const job = await poll(jobId, signal);
    signal.throwIfAborted();

    if (job.status === 'done' && job.url) {
      return (await clients.http(job.url, { signal })).body;
    }

    if (Date.now() >= deadline) {
      throw new Error(`image job ${jobId} not done after 120 s`);
    }

    await sleep(POLL_EVERY_MS, undefined, { signal });
  }
}
