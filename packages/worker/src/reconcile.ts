import { type Db, decryptToken, getJson, type Logger } from '@ryze/core';
import type { Clients } from './clients.js';

interface InspectedSite {
  token: string;
  posts: { id: string; status: 'draft' | 'live'; article_id: string | null }[];
}

export interface Reconcile {
  db: Db;
  clients: Clients;
  log: Logger;
  siteTokenKey: string;
  fakePlatformsUrl?: string; // in production: each platform's list endpoint, by our article-id field
}

// Runs once (Compose loops it every 60 s). Three read-mostly jobs: delete stray drafts, report
// stuck operations, report the pipeline's numbers.
export async function reconcile(r: Reconcile) {
  const strays = r.fakePlatformsUrl ? await removeStrays(r, r.fakePlatformsUrl) : null;

  // Leases already make these reclaimable; a step running this long means a hung worker.
  const stuck = await r.db.query(
    `SELECT id, article_id, step, attempts, updated_at FROM operations
     WHERE status = 'running' AND updated_at < now() - interval '15 minutes'`,
  );
  for (const op of stuck.rows) r.log.warn(op, 'stuck operation');

  const ops = await r.db.query<{ step: string; status: string; n: number }>(
    'SELECT step, status, count(*) AS n FROM operations GROUP BY step, status ORDER BY step, status',
  );
  const articles = await r.db.query(
    'SELECT count(*) AS total, count(published_at) AS published FROM articles',
  );
  const spend = await r.db.query(
    `SELECT COALESCE(sum((usage ->> 'cost_usd')::numeric), 0)::float8 AS usd FROM operations`,
  );
  const operations: Record<string, Record<string, number>> = {};
  for (const o of ops.rows) {
    operations[o.step] ??= {};
    operations[o.step][o.status] = o.n;
  }
  return {
    strays,
    stuck: stuck.rowCount,
    operations,
    articles: articles.rows[0],
    spend_usd: Math.round(spend.rows[0].usd * 1e6) / 1e6,
  };
}

// A post carrying our article id is a stray when that article recorded a different post. A post
// whose article has not recorded one yet belongs to a draft step still in flight: left alone.
async function removeStrays(r: Reconcile, inspectUrl: string) {
  const inspected = await getJson<{ sites: InspectedSite[] }>(
    r.clients.http,
    `${inspectUrl}/_admin/inspect`,
  );
  const { rows: sites } = await r.db.query('SELECT id, platform, base_url, token_enc FROM sites');
  const byToken = new Map(sites.map((s) => [decryptToken(s.token_enc, r.siteTokenKey), s]));
  let found = 0;
  let deleted = 0;
  for (const remote of inspected.sites) {
    const s = byToken.get(remote.token);
    if (!s) continue;
    const site = { id: s.id, platform: s.platform, base_url: s.base_url, token: remote.token };
    const { rows } = await r.db.query<{ id: string; remote_post_id: string | null }>(
      'SELECT id, remote_post_id FROM articles WHERE site_id = $1',
      [site.id],
    );
    const recorded = new Map(rows.map((a) => [a.id, a.remote_post_id]));
    for (const post of remote.posts) {
      if (!post.article_id) continue; // not ours
      const postId = recorded.get(post.article_id);
      if (postId === post.id || postId === null) continue;
      found++;
      if (post.status !== 'draft') {
        r.log.warn({ site_id: site.id, post_id: post.id }, 'live stray post: left for a human');
        continue;
      }
      await r.clients.adapters[site.platform as 'wordpress' | 'shopify'].deleteDraft(site, post.id);
      deleted++;
      r.log.info({ site_id: site.id, post_id: post.id }, 'deleted stray draft');
    }
  }
  return { found, deleted };
}
