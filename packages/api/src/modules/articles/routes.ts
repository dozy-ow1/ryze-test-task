import type { Database } from '@ryze/core';
import type { FastifyPluginAsync } from 'fastify';
import { createArticleHandlers } from './handlers.js';

export const articleRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const handlers = createArticleHandlers(db);
  app.post('/', { prefixTrailingSlash: 'no-slash' }, handlers.create);
  app.post('/bulk', handlers.bulk);
  app.get('/summary', handlers.summary);
  app.get('/:id', handlers.detail);
  app.post('/:id/retry', handlers.retry);
};
