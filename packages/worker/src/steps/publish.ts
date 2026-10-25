import { Permanent, SQL, withQuota } from '@ryze/core';
import type { Clients } from '../clients.js';
import type { StepFn } from '../runner.js';

// A post that is already live (an earlier attempt published it, or the draft was adopted live)
// is only read: its URL is recorded and the step finishes. One take of the site's bucket covers
// the status read and the publish, like upload.
export const publish: StepFn<Clients> = async ({ article, site, clients }) => {
  const postId = article.remote_post_id;
  if (!postId) throw new Permanent('no post to publish');
  const adapter = clients.adapters[site.platform];
  const url = await withQuota(clients.db, `site:${site.id}`, 2, async () => {
    const now = await adapter.getStatus(site, postId);
    return now.status === 'live' && now.url ? now.url : adapter.publish(site, postId);
  });
  return { write: { sql: SQL.WRITE_PUBLISHED, params: [article.id, url] } };
};
