import { SQL, withQuota } from '@ryze/shared';
import type { Clients } from '../../infrastructure/clients.js';
import { coverKey } from '../../infrastructure/store.js';
import type { StepFn } from '../../runtime/types.js';
import { SITE_REQUEST_UNITS } from '../../settings.js';

// The file name is the key: an upload whose answer was lost is found again instead of repeated.
// Reserve the lookup and write budget together, so a retry cannot spend its last unit on lookup.
export const upload: StepFn<Clients> = async ({ article, site, clients, signal }) => {
  const adapter = clients.platform;
  const filename = `ryze-${article.id}.jpg`;

  const mediaId = await withQuota(
    clients.db,
    `site:${site.id}`,
    SITE_REQUEST_UNITS.upload,
    async () => {
      signal.throwIfAborted();
      const existing = await adapter.findMedia(site, filename, signal);

      if (existing) {
        return existing;
      }

      signal.throwIfAborted();
      const bytes = await clients.store.get(coverKey(article.id), signal);
      signal.throwIfAborted();

      return adapter.uploadMedia(site, filename, bytes, signal);
    },
  );

  return { write: { sql: SQL.WRITE_MEDIA, params: [article.id, mediaId] } };
};
