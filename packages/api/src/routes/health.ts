import type { Database } from '@ryze/core';
import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await db.query('SELECT 1');

      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
};
