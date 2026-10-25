import { type Database, SQL, transaction } from '@ryze/core';
import type { RouteHandlerMethod } from 'fastify';
import { HttpProblem } from '../../utils/errors.js';
import { idParam, parse } from '../../utils/validation.js';
import { articleItem, bulkBody } from './schemas.js';

async function requireActiveSites(db: Pick<Database, 'query'>, ids: string[]): Promise<void> {
  const { rows } = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM sites WHERE id = ANY ($1::uuid[]) ORDER BY id FOR SHARE',
    [[...new Set(ids)]],
  );

  const status = new Map(rows.map((r) => [r.id, r.status]));

  for (const id of ids) {
    if (!status.has(id)) {
      throw new HttpProblem(404, `unknown site ${id}`);
    }

    if (status.get(id) !== 'active') {
      throw new HttpProblem(409, `site ${id} is ${status.get(id)}`);
    }
  }
}

export function createArticleHandlers(db: Database) {
  return {
    create: async (req, reply) => {
      const item = parse(articleItem, req.body);

      // A repeated key answers with its article, whatever happened to the site since.
      const known = await db.query<{ id: string }>(SQL.INTAKE_EXISTING, [
        item.site_id,
        item.idempotency_key,
      ]);

      if (known.rows[0]) {
        return reply.code(200).send({ article_id: known.rows[0].id });
      }

      const { id, created } = await transaction(db, async (c) => {
        await requireActiveSites(c, [item.site_id]);
        const params = [item.site_id, item.idempotency_key, item.brief];

        const inserted = await c.query<{ id: string }>(SQL.INTAKE, params);

        if (inserted.rows[0]) {
          await c.query(SQL.INTAKE_OP, [inserted.rows[0].id]);

          return { id: inserted.rows[0].id, created: true };
        }

        const existing = await c.query<{ id: string }>(SQL.INTAKE_EXISTING, params.slice(0, 2));

        return { id: existing.rows[0].id, created: false };
      });

      return reply.code(created ? 202 : 200).send({ article_id: id });
    },

    bulk: async (req, reply) => {
      const { items } = parse(bulkBody, req.body);

      // Rows go in in key order: two bulk requests with overlapping keys then lock them in the same
      // order and cannot deadlock.
      const ordered = [...items].sort((a, b) => {
        const x = `${a.site_id}|${a.idempotency_key}`;
        const y = `${b.site_id}|${b.idempotency_key}`;

        return x < y ? -1 : x > y ? 1 : 0;
      });

      const siteIds = ordered.map((i) => i.site_id);
      const keys = ordered.map((i) => i.idempotency_key);

      const results = await transaction(db, async (c) => {
        type Row = { id: string; site_id: string; idempotency_key: string };
        const existing = await c.query<Row>(SQL.BULK_INTAKE_IDS, [siteIds, keys]);

        const known = new Set(existing.rows.map((r) => `${r.site_id}|${r.idempotency_key}`));
        await requireActiveSites(
          c,
          ordered
            .filter((i) => !known.has(`${i.site_id}|${i.idempotency_key}`))
            .map((i) => i.site_id),
        );
        const briefs = ordered.map((i) => i.brief);

        const inserted = await c.query<Row>(SQL.BULK_INTAKE, [siteIds, keys, briefs]);

        if (inserted.rowCount) {
          await c.query(SQL.BULK_INTAKE_OPS, [inserted.rows.map((r) => r.id)]);
        }

        const all = await c.query<Row>(SQL.BULK_INTAKE_IDS, [siteIds, keys]);

        const idOf = new Map(all.rows.map((r) => [`${r.site_id}|${r.idempotency_key}`, r.id]));
        const fresh = new Set(inserted.rows.map((r) => `${r.site_id}|${r.idempotency_key}`));

        return items.map((i) => {
          const key = `${i.site_id}|${i.idempotency_key}`;

          // A key repeated inside one batch is created once: by its first occurrence.
          return { article_id: idOf.get(key), created: fresh.delete(key) };
        });
      });

      return reply.code(202).send({ results });
    },

    summary: async () => {
      const ops = await db.query<{ step: string; status: string; n: number }>(
        'SELECT step, status, count(*) AS n FROM operations GROUP BY step, status',
      );

      const articles = await db.query<{ total: number; published: number }>(
        'SELECT count(*) AS total, count(published_at) AS published FROM articles',
      );

      const operations: Record<string, Record<string, number>> = {};

      for (const r of ops.rows) {
        operations[r.step] ??= {};
        operations[r.step][r.status] = r.n;
      }

      return { operations, articles: articles.rows[0] };
    },

    detail: async (req) => {
      const { id } = parse(idParam, req.params);

      const article = await db.query('SELECT * FROM articles WHERE id = $1', [id]);

      if (!article.rowCount) {
        throw new HttpProblem(404, 'unknown article');
      }

      const operations = await db.query(
        `SELECT step, status, attempts, last_error, updated_at, usage FROM operations
       WHERE article_id = $1 ORDER BY id`,
        [id],
      );

      return { article: article.rows[0], operations: operations.rows };
    },

    retry: async (req, reply) => {
      const { id } = parse(idParam, req.params);

      const retried = await db.query<{ id: number }>(SQL.RETRY_ARTICLE, [id]);

      if (retried.rowCount === 1) {
        return reply.code(202).send({ operation_id: retried.rows[0].id });
      }

      const known = await db.query('SELECT 1 FROM articles WHERE id = $1', [id]);

      if (!known.rowCount) {
        throw new HttpProblem(404, 'unknown article');
      }

      throw new HttpProblem(409, 'the latest operation is neither failed nor unknown');
    },
  } satisfies Record<string, RouteHandlerMethod>;
}
