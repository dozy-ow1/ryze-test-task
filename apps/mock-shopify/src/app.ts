import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { adminRoutes } from './modules/admin/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { shopifyRoutes } from './modules/shopify/routes.js';
import type { Site } from './modules/shopify/state.js';
import { createTransport, type TransportOptions } from './modules/shopify/transport.js';

export interface AppOptions extends TransportOptions {
  logLevel?: string;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { name: 'mock-shopify', level: options.logLevel ?? 'silent' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
    forceCloseConnections: true,
  });

  const sites = new Map<string, Site>();

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.addContentTypeParser(/^multipart\/form-data/, { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  app.register(healthRoutes);
  app.register(adminRoutes, { prefix: '/_admin', sites, defaults: options });
  app.register(shopifyRoutes, { sites, route: createTransport(app, sites, options) });

  return app;
}
