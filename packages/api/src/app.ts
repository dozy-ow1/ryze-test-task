import type { Database } from '@ryze/core';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { articleRoutes } from './articles.js';
import { HttpProblem, isDbUnavailable } from './errors.js';
import { siteRoutes } from './sites.js';

export { isDbUnavailable } from './errors.js';

// The API owns intake only: workers perform every external call.
export function buildApp(opts: { db: Database; siteTokenKey: string; logLevel?: string }) {
  const { db } = opts;
  const app: FastifyInstance = Fastify({
    logger: { level: opts.logLevel ?? 'info' },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpProblem) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    if (isDbUnavailable(err)) {
      return reply.code(503).send({ error: 'database unavailable' });
    }
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

  siteRoutes(app, db, opts.siteTokenKey);
  articleRoutes(app, db);
  return app;
}
