import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { adminRoutes } from './modules/admin/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { wordpressRoutes } from './modules/wordpress/routes.js';
import type { Site } from './modules/wordpress/state.js';
import { createTransport, type TransportOptions } from './modules/wordpress/transport.js';

export interface AppOptions extends TransportOptions {
  logLevel?: string;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { name: 'mock-wordpress', level: options.logLevel ?? 'silent' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
    forceCloseConnections: true,
  });

  const sites = new Map<string, Site>();

  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  app.register(healthRoutes);
  app.register(adminRoutes, { prefix: '/_admin', sites, defaults: options });
  app.register(wordpressRoutes, {
    prefix: '/wordpress/wp/v2',
    route: createTransport(app, sites, options),
  });

  return app;
}
