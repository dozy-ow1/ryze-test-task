import { SQL, withQuota } from '@ryze/core';
import type { Clients } from '../clients.js';
import type { StepFn } from '../runner.js';

const FRESH_MS = 10 * 60_000;

// One credentials check per site per 10 minutes, however many articles it has in flight.
export const verify: StepFn<Clients> = async ({ site, clients }) => {
  if (site.verified_at && Date.now() - site.verified_at.getTime() < FRESH_MS) return {};
  const adapter = clients.adapters[site.platform];
  await withQuota(clients.db, `site:${site.id}`, 1, () => adapter.verify(site));
  return { write: { sql: SQL.WRITE_VERIFIED, params: [site.id] } };
};
