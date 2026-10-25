import { Permanent, SQL, withQuota } from '@ryze/core';
import type { Clients } from '../clients.js';
import type { StepFn } from '../runner.js';
import { coverKey } from '../store.js';

// The slug is the key: a draft whose answer was lost is adopted instead of created twice. Lookup
// and creation share one take of the site's bucket, like upload.
export const draft: StepFn<Clients> = async ({ article, site, clients }) => {
  const { title, slug, body_html: bodyHtml, remote_media_id: mediaId } = article;
  if (!title || !slug || !bodyHtml || !mediaId) throw new Permanent('text or media id missing');
  const adapter = clients.adapters[site.platform];
  const postId = await withQuota(
    clients.db,
    `site:${site.id}`,
    2,
    async () =>
      (await adapter.findBySlug(site, slug))?.id ??
      adapter.createDraft(site, {
        title,
        slug,
        bodyHtml,
        mediaId,
        articleId: article.id,
        image: () => clients.store.get(coverKey(article.id)),
      }),
  );
  return { write: { sql: SQL.WRITE_POST, params: [article.id, postId] } };
};
