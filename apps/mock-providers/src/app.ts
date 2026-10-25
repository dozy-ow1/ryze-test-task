import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { adminRoutes } from './modules/admin/routes.js';
import { generationRoutes } from './modules/generation/routes.js';
import { createRuntime, type GenerationOptions } from './modules/generation/runtime.js';
import { healthRoutes } from './modules/health/routes.js';

export interface AppOptions extends GenerationOptions {
  logLevel?: string;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { name: 'mock-providers', level: options.logLevel ?? 'silent' },
    logController: new LogController({ disableRequestLogging: true }),
    forceCloseConnections: true,
  });

  const runtime = createRuntime(options);

  app.register(healthRoutes);
  app.register(adminRoutes, { prefix: '/_admin', runtime });
  app.register(generationRoutes, { prefix: '/v1', runtime });

  return app;
}
