import { SQL, withQuota } from '@ryze/core';
import type { Clients } from '../../infrastructure/clients.js';
import { coverKey } from '../../infrastructure/store.js';
import type { StepFn } from '../../runtime/types.js';

// The file name is the key: an upload whose answer was lost is found again instead of repeated.
// The lookup and the upload share one take of the site's bucket (2 units): if the lookup took its
// own unit, under contention it would keep spending the unit the upload then waits for.
export const upload: StepFn<Clients> = async ({ article, site, clients, signal }) => {
  const adapter = clients.platform;
  const filename = `ryze-${article.id}.jpg`;

  const mediaId = await withQuota(clients.db, `site:${site.id}`, 2, async () => {
    signal.throwIfAborted();
    const existing = await adapter.findMedia(site, filename, signal);

    if (existing) {
      return existing;
    }

    signal.throwIfAborted();
    const bytes = await clients.store.get(coverKey(article.id), signal);
    signal.throwIfAborted();

    return adapter.uploadMedia(site, filename, bytes, signal);
  });

  return { write: { sql: SQL.WRITE_MEDIA, params: [article.id, mediaId] } };
};
