import { SQL, withQuota } from '@ryze/core';
import type { Clients } from '../../infrastructure/clients.js';
import type { StepFn } from '../../runtime/types.js';

const FRESH_MS = 10 * 60_000;

// Reuse recent verification; concurrent articles may verify the same site.
export const verify: StepFn<Clients> = async ({ site, clients, signal }) => {
  if (site.verified_at && Date.now() - site.verified_at.getTime() < FRESH_MS) {
    return {};
  }

  const adapter = clients.platform;
  await withQuota(clients.db, `site:${site.id}`, 1, () => {
    signal.throwIfAborted();

    return adapter.verify(site, signal);
  });

  return { write: { sql: SQL.WRITE_VERIFIED, params: [site.id, site.tokenVersion ?? null] } };
};
