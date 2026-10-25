import { FAULT_KINDS, type FaultKind } from '@ryze/core';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { type Faults, newSite, type Route, type Site } from './sites.js';
import { wordpressRoutes } from './wordpress.js';

export interface AppOptions {
  // Faults for sites registered without their own.
  faultRate: number;
  faultKinds: FaultKind[];
  logLevel?: string;
  random?: () => number;
  delays?: Partial<{ slowMs: [min: number, max: number]; timeoutHoldMs: number }>;
}

const registerSiteBody = {
  type: 'object',
  required: ['token', 'platform'],
  properties: {
    token: { type: 'string', minLength: 1 },
    platform: { const: 'wordpress' },
    faults: {
      type: 'object',
      properties: {
        rate: { type: 'number', minimum: 0, maximum: 1 },
        kinds: { type: 'array', items: { enum: FAULT_KINDS } },
      },
    },
  },
};

interface RegisterSite {
  token: string;
  platform: 'wordpress';
  faults?: Partial<Faults>;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const random = options.random ?? Math.random;
  const [slowMin, slowMax] = options.delays?.slowMs ?? [2_000, 10_000];
  const timeoutHoldMs = options.delays?.timeoutHoldMs ?? 40_000;
  const sites = new Map<string, Site>();

  const app = Fastify({
    logger: { name: 'mock-wordpress', level: options.logLevel ?? 'silent' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024, // Raw cover uploads and post content.
    // A request held by a timeout fault never ends on its own and close() would wait for it, so
    // close() destroys every connection.
    forceCloseConnections: true,
  });

  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  // Hold and slow timers, cleared on close so that none fires into a closed app.
  const timers = new Set<NodeJS.Timeout>();

  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  app.addHook('onClose', async () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  });

  // Registering a known token again updates its faults and keeps its data.
  app.post('/_admin/sites', { schema: { body: registerSiteBody } }, async (request, reply) => {
    const { token, platform, faults } = request.body as RegisterSite;

    const effective: Faults = {
      rate: faults?.rate ?? options.faultRate,
      kinds: faults?.kinds ?? options.faultKinds,
    };

    const site = sites.get(token);

    if (site) {
      site.faults = effective;
    } else {
      sites.set(token, newSite(token, effective));
    }

    reply.code(201);

    return { token, platform, faults: effective };
  });

  // What the demo asserts on. Ids are strings because the pipeline stores them as text.
  app.get('/_admin/inspect', async () => ({
    sites: [...sites.values()].map((site) => ({
      token: site.token,
      platform: site.platform,
      faults: site.faults,
      faults_injected: site.faultsInjected,
      media: site.media.map((m) => ({ id: String(m.id), filename: m.filename })),
      posts: site.posts.map((p) => ({
        id: String(p.id),
        slug: p.slug,
        status: p.url === null ? 'draft' : 'live',
        article_id: p.articleId,
        media_id: p.mediaId === null ? null : String(p.mediaId),
        url: p.url,
      })),
    })),
  }));

  app.post('/_admin/reset', async () => {
    sites.clear();

    return { ok: true };
  });

  app.get('/healthz', async () => ({ ok: true }));

  // With probability `rate` a write gets a fault, its kind drawn uniformly from `kinds`.
  const pickFault = ({ rate, kinds }: Faults): FaultKind | undefined =>
    kinds.length > 0 && random() < rate ? kinds[Math.floor(random() * kinds.length)] : undefined;

  // Writes can fail before or after taking effect; reads remain available for recovery lookups.
  const route: Route = (handler) => async (request, reply) => {
    const authorization = request.headers.authorization ?? '';
    const bearer = /^Bearer (.+)$/i.exec(authorization)?.[1];
    const basic = /^Basic (.+)$/i.exec(authorization)?.[1];
    const token = bearer ?? (basic ? Buffer.from(basic, 'base64').toString('utf8') : undefined);
    const site = token === undefined ? undefined : sites.get(token);

    if (!site) {
      reply.code(401);

      return { error: 'this route needs credentials registered for WordPress' };
    }

    const write = request.method === 'POST';
    const fault = write ? pickFault(site.faults) : undefined;

    if (fault === undefined) {
      return handler(site, request, reply);
    }

    site.faultsInjected[fault] += 1;
    const { method, url } = request;
    request.log.info({ fault, method, url }, 'injected fault');

    switch (fault) {
      case '429':
        reply.code(429).header('retry-after', '2');
        return { error: 'rate limited, retry later' };
      case '500':
        reply.code(500);
        return { error: 'internal server error' };
      case 'timeout': {
        // No answer and no write: the socket stays open until the hold ends.
        reply.hijack();
        const socket = request.raw.socket;
        later(timeoutHoldMs, () => socket.destroy());

        return;
      }
      case 'slow':
        await new Promise<void>((resolve) =>
          later(slowMin + random() * (slowMax - slowMin), resolve),
        );
        return handler(site, request, reply);
      case 'complete_then_drop':
        // The write happens, then the connection drops before any answer.
        await handler(site, request, reply);
        reply.hijack();
        request.raw.socket.destroy();
        return;
    }
  };

  app.register(async (scope) => wordpressRoutes(scope, route), {
    prefix: '/wordpress/wp/v2',
  });

  return app;
}
