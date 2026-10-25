import { type Database, encryptToken, SQL, transaction, validateHttpUrl } from '@ryze/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpProblem } from './errors.js';
import { idParam, parse } from './validation.js';

const SITE_QUOTAS = {
  wordpress: { capacity: 4, refill: 2 },
  shopify: { capacity: 40, refill: 2 },
} as const;

const siteUrl = z.url().refine((value) => {
  try {
    validateHttpUrl(value);
    return !value.includes('?') && !value.includes('#');
  } catch {
    return false;
  }
}, 'must be an HTTP(S) root without credentials, query or fragment');
const tokenBody = z.object({ token: z.string().min(1) });
const siteBody = tokenBody.extend({
  platform: z.enum(['wordpress', 'shopify']),
  base_url: siteUrl,
});

export function siteRoutes(app: FastifyInstance, db: Database, siteTokenKey: string): void {
  app.post('/sites', async (req, reply) => {
    const body = parse(siteBody, req.body);
    const quota = SITE_QUOTAS[body.platform];
    const id = await transaction(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO sites (platform, base_url, token_enc) VALUES ($1, $2, $3) RETURNING id',
        [body.platform, body.base_url, encryptToken(body.token, siteTokenKey)],
      );
      const siteId = rows[0].id;
      await c.query(SQL.SITE_QUOTA, [`site:${siteId}`, quota.capacity, quota.refill]);
      return siteId;
    });
    return reply.code(201).send({ id });
  });

  // Explicitly replacing credentials reactivates the site. Failed articles are retried separately.
  app.patch('/sites/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { token } = parse(tokenBody, req.body);
    await transaction(db, async (c) => {
      const updated = await c.query(
        `UPDATE sites SET token_enc = $2, status = 'active', verified_at = NULL WHERE id = $1`,
        [id, encryptToken(token, siteTokenKey)],
      );
      if (!updated.rowCount) {
        throw new HttpProblem(404, 'unknown site');
      }
      await c.query(`UPDATE quotas SET failures = 0, open_until = NULL WHERE scope = $1`, [
        `site:${id}`,
      ]);
    });
    return reply.code(200).send({ id });
  });
}
