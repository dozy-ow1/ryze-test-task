import type { Database } from '@ryze/core';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { articleRoutes } from './modules/articles/routes.js';
import { siteRoutes } from './modules/sites/routes.js';
import { healthRoutes } from './routes/health.js';
import { HttpProblem, isDbUnavailable } from './utils/errors.js';

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

  app.register(healthRoutes, { db });
  app.register(siteRoutes, { prefix: '/sites', db, siteTokenKey: opts.siteTokenKey });
  app.register(articleRoutes, { prefix: '/articles', db });

  return app;
}
