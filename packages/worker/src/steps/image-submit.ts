import { Permanent, withQuota } from '@ryze/core';
import type { Clients } from '../clients.js';
import type { StepFn } from '../runner.js';

// Starts the provider's job. The job id rides on the image_fetch row (provider_ref), so a worker
// that dies while polling never starts a second job. Dying between the submit and COMPLETE does:
// that window is accepted and counted by the demo.
export const imageSubmit: StepFn<Clients> = async ({ article, clients, signal }) => {
  const submit = clients.image.submit;

  if (!submit) {
    throw new Permanent('the image provider takes no jobs');
  }

  const prompt = article.image_prompt ?? article.brief;

  const { jobId } = await withQuota(clients.db, 'provider:image', 1, () => {
    signal.throwIfAborted();

    return submit(prompt, signal);
  });

  return { providerRef: jobId };
};
