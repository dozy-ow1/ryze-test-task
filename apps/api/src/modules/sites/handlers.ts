import { type Database, encryptToken, SQL, transaction } from '@ryze/core';
import type { RouteHandlerMethod } from 'fastify';
import { HttpProblem } from '../../utils/errors.js';
import { idParam, parse } from '../../utils/validation.js';

import { SITE_QUOTA } from './constants.js';
import { siteBody, tokenBody } from './schemas.js';

export function createSiteHandlers(db: Database, siteTokenKey: string) {
  return {
    create: async (req, reply) => {
      const body = parse(siteBody, req.body);

      const id = await transaction(db, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          'INSERT INTO sites (platform, base_url, token_enc) VALUES ($1, $2, $3) RETURNING id',
          [body.platform, body.base_url, encryptToken(body.token, siteTokenKey)],
        );

        const siteId = rows[0].id;
        await c.query(SQL.SITE_QUOTA, [`site:${siteId}`, SITE_QUOTA.capacity, SITE_QUOTA.refill]);

        return siteId;
      });

      return reply.code(201).send({ id });
    },

    update: async (req, reply) => {
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
    },
  } satisfies Record<string, RouteHandlerMethod>;
}
