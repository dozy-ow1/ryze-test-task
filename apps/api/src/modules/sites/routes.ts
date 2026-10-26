import type { Database } from '@ryze/shared/database/client';
import type { FastifyPluginAsync } from 'fastify';
import { createSiteHandlers } from './handlers.js';

export const siteRoutes: FastifyPluginAsync<{ db: Database; siteTokenKey: string }> = async (
  app,
  { db, siteTokenKey },
) => {
  const handlers = createSiteHandlers(db, siteTokenKey);
  app.post('/', { prefixTrailingSlash: 'no-slash' }, handlers.create);
  app.patch('/:id', handlers.update);
};
