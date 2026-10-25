import { createHttp, createLogger, createWordPress, encryptToken } from '@ryze/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../../../../packages/core/testing/database.js';
import { buildApp } from '../../../../mock-wordpress/src/app.js';
import { registerSite } from '../../../../mock-wordpress/testing/helpers.js';
import type { Clients } from '../../infrastructure/clients.js';
import { reconcile } from './reconcile.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const mock = buildApp({ faultRate: 0, faultKinds: [] });
const http = createHttp(5_000, { allowPrivateNetwork: true });
const wp = createWordPress(http);
let base: string;
let t: TestDb;

beforeAll(async () => {
  t = await testDb();
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const address = mock.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await mock.close();
  await t.drop();
});

describe('reconciler', () => {
  it('deletes only drafts that duplicate a post their article recorded', async () => {
    const token = 'wordpress-reconcile';
    await registerSite(mock, token);
    // The same blog registered twice: two site rows, one account.
    const siteIds: string[] = [];

    for (let i = 0; i < 2; i++) {
      const { rows } = await t.db.query(
        `INSERT INTO sites (platform, base_url, token_enc) VALUES ('wordpress', $1, $2) RETURNING id`,
        [`${base}/wordpress`, encryptToken(token, KEY)],
      );
      siteIds.push(rows[0].id);
    }

    const site = {
      id: siteIds[0],
      platform: 'wordpress' as const,
      base_url: `${base}/wordpress`,
      token,
    };

    const media = await wp.uploadMedia(site, 'ryze-cover.jpg', Buffer.from('x'));

    const article = async (siteId: string, key: string) =>
      (
        await t.db.query(
          `INSERT INTO articles (site_id, idempotency_key, brief) VALUES ($1, $2, 'b') RETURNING id`,
          [siteId, key],
        )
      ).rows[0].id as string;

    const draft = (articleId: string, slug: string) =>
      wp.createDraft(site, {
        title: slug,
        slug,
        bodyHtml: '<p>x</p>',
        mediaId: media,
        articleId,
      });

    const a1 = await article(siteIds[0], 'a1'); // recorded its post on site row 1

    const a2 = await article(siteIds[1], 'a2'); // recorded its post on site row 2

    const a3 = await article(siteIds[1], 'a3'); // draft step still in flight

    const p1 = await draft(a1, 'p1');

    const p2 = await draft(a2, 'p2');

    const duplicate = await draft(a2, 'p2-again');

    const inFlight = await draft(a3, 'p3');

    const foreign = await draft(crypto.randomUUID(), 'other-environment');
    await t.db.query('UPDATE articles SET remote_post_id = $2 WHERE id = $1', [a1, p1]);
    await t.db.query('UPDATE articles SET remote_post_id = $2 WHERE id = $1', [a2, p2]);

    const report = await reconcile({
      db: t.db,
      clients: { http, platform: wp } as unknown as Clients,
      log: createLogger('test', 'silent'),
      siteTokenKey: KEY,
      mockWordPressUrl: base,
    });
    expect(report.strays).toEqual({ found: 1, deleted: 1 });
    const inspect = (await (await fetch(`${base}/_admin/inspect`)).json()) as {
      sites: { token: string; posts: { id: string }[] }[];
    };

    const left = inspect.sites.find((s) => s.token === token)?.posts.map((p) => p.id);
    expect(left).toEqual([p1, p2, inFlight, foreign]);
    expect(left).not.toContain(duplicate);
  });
});
