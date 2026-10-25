import { SQL, withQuota } from '@ryze/core';
import type { Clients } from '../clients.js';
import type { StepFn } from '../runner.js';
import { coverKey } from '../store.js';

// The file name is the key: an upload whose answer was lost is found again instead of repeated.
// The lookup and the upload share one take of the site's bucket (2 units): if the lookup took its
// own unit, under contention it would keep spending the unit the upload then waits for.
export const upload: StepFn<Clients> = async ({ article, site, clients }) => {
  const adapter = clients.adapters[site.platform];
  const filename = `ryze-${article.id}.jpg`;
  const mediaId = await withQuota(
    clients.db,
    `site:${site.id}`,
    2,
    async () =>
      (await adapter.findMedia(site, filename)) ??
      adapter.uploadMedia(site, filename, await clients.store.get(coverKey(article.id))),
  );
  return { write: { sql: SQL.WRITE_MEDIA, params: [article.id, mediaId] } };
};
