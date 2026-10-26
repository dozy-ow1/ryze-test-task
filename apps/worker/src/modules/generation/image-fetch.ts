import { Deferred, imageUsage, Permanent, withQuota } from '@ryze/shared';
import sharp from 'sharp';
import type { Clients } from '../../infrastructure/clients.js';
import { coverKey } from '../../infrastructure/store.js';
import type { StepContext, StepFn } from '../../runtime/types.js';

const POLL_EVERY_MS = 1_000;
const POLL_FOR_MS = 120_000;

// The cover's key is fixed by the article id: if an earlier attempt stored it, nothing is paid
// again. Otherwise check the job (async provider) or generate (sync), crop and store.
export const imageFetch: StepFn<Clients> = async (ctx) => {
  const { article, clients, signal } = ctx;
  signal.throwIfAborted();
  const key = coverKey(article.id);

  if (await clients.store.exists(key, signal)) {
    return { usage: imageUsage(clients.image.model) };
  }

  signal.throwIfAborted();

  const raw =
    clients.image.kind === 'sync' ? await generate(ctx) : await fetchJob(ctx, ctx.op.provider_ref);
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
async function fetchJob(
  { clients, signal, op }: StepContext<Clients>,
  jobId: string | null,
): Promise<Buffer> {
  const poll = clients.image.poll;

  if (!poll || !jobId) {
    throw new Permanent('no image job to wait for');
  }

  signal.throwIfAborted();
  const job = await poll(jobId, signal);
  signal.throwIfAborted();

  if (job.status === 'done') {
    if (!job.url) {
      throw new Permanent('completed image job has no download URL');
    }

    return (await clients.http(job.url, { signal })).body;
  }

  const deadline = op.created_at.getTime() + POLL_FOR_MS;

  if (Date.now() >= deadline) {
    throw new Permanent(`image job ${jobId} did not finish within ${POLL_FOR_MS / 1000} seconds`);
  }

  throw new Deferred(
    new Date(Math.min(Date.now() + POLL_EVERY_MS, deadline)),
    'image job still pending',
  );
}
