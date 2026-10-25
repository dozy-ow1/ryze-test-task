import { type Db, encryptToken, SQL, tx } from '@ryze/core';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { z } from 'zod';

// The intake API. It only writes rows; workers pick them up. No authentication in this version.

const SITE_QUOTAS = {
  wordpress: { capacity: 4, refill: 2 },
  shopify: { capacity: 40, refill: 2 },
} as const;

const siteBody = z.object({
  platform: z.enum(['wordpress', 'shopify']),
  base_url: z.url(),
  token: z.string().min(1),
});
const articleItem = z.object({
  site_id: z.uuid(),
  brief: z.string().min(1),
  idempotency_key: z.string().min(1).max(200),
});
const bulkBody = z.object({ items: z.array(articleItem).min(1).max(1000) });
const idParam = z.object({ id: z.uuid() });

class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpProblem(400, 'validation failed', r.error.issues);
  return r.data;
}

const DB_DOWN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  '57P01', // admin_shutdown (connection terminated)
  '57P02',
  '57P03', // cannot_connect_now
  '08000',
  '08003',
  '08006',
]);

export function isDbUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  if (e?.code && DB_DOWN_CODES.has(e.code)) return true;
  if (/Connection terminated|timeout exceeded when trying to connect/i.test(e?.message ?? '')) {
    return true;
  }
  return Array.isArray(e?.errors) && e.errors.some(isDbUnavailable);
}

async function requireActiveSites(db: Db, ids: string[]): Promise<void> {
  const { rows } = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM sites WHERE id = ANY ($1::uuid[])',
    [[...new Set(ids)]],
  );
  const status = new Map(rows.map((r) => [r.id, r.status]));
  for (const id of ids) {
    if (!status.has(id)) throw new HttpProblem(404, `unknown site ${id}`);
    if (status.get(id) !== 'active') throw new HttpProblem(409, `site ${id} is ${status.get(id)}`);
  }
}

export function buildApp(opts: { db: Db; siteTokenKey: string; logLevel?: string }) {
  const { db, siteTokenKey } = opts;
  const app: FastifyInstance = Fastify({
    logger: { level: opts.logLevel ?? 'info' },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpProblem) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    if (isDbUnavailable(err)) return reply.code(503).send({ error: 'database unavailable' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post('/sites', async (req, reply) => {
    const body = parse(siteBody, req.body);
    const quota = SITE_QUOTAS[body.platform];
    const id = await tx(db, async (c) => {
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

  app.post('/articles', async (req, reply) => {
    const item = parse(articleItem, req.body);
    await requireActiveSites(db, [item.site_id]);
    const { id, created } = await tx(db, async (c) => {
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
  });

  app.post('/articles/bulk', async (req, reply) => {
    const { items } = parse(bulkBody, req.body);
    await requireActiveSites(
      db,
      items.map((i) => i.site_id),
    );
    const siteIds = items.map((i) => i.site_id);
    const keys = items.map((i) => i.idempotency_key);
    const results = await tx(db, async (c) => {
      type Row = { id: string; site_id: string; idempotency_key: string };
      const briefs = items.map((i) => i.brief);
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
  });

  app.get('/articles/summary', async () => {
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
  });

  app.get('/articles/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const article = await db.query('SELECT * FROM articles WHERE id = $1', [id]);
    if (!article.rowCount) throw new HttpProblem(404, 'unknown article');
    const operations = await db.query(
      `SELECT step, status, attempts, last_error, updated_at FROM operations
       WHERE article_id = $1 ORDER BY id`,
      [id],
    );
    return { article: article.rows[0], operations: operations.rows };
  });

  app.post('/articles/:id/retry', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const retried = await db.query<{ id: number }>(SQL.RETRY_ARTICLE, [id]);
    if (retried.rowCount === 1) return reply.code(202).send({ operation_id: retried.rows[0].id });
    const known = await db.query('SELECT 1 FROM articles WHERE id = $1', [id]);
    if (!known.rowCount) throw new HttpProblem(404, 'unknown article');
    throw new HttpProblem(409, 'the latest operation is neither failed nor unknown');
  });

  return app;
}
