import { Permanent, SQL, withQuota } from '@ryze/shared';
import type { Clients } from '../../infrastructure/clients.js';
import type { StepFn } from '../../runtime/types.js';
import { SITE_REQUEST_UNITS } from '../../settings.js';

// The Shopify adapter owns the status lookup and skips an already completed publication.
export const publish: StepFn<Clients> = async ({ article, site, clients, signal }) => {
  const postId = article.remote_post_id;

  if (!postId) {
    throw new Permanent('no post to publish');
  }

  const adapter = clients.platform;

  const url = await withQuota(
    clients.db,
    `site:${site.id}`,
    SITE_REQUEST_UNITS.publish,
    async () => {
      signal.throwIfAborted();

      return adapter.publish(site, postId, signal);
    },
  );

  return { write: { sql: SQL.WRITE_PUBLISHED, params: [article.id, url] } };
};
