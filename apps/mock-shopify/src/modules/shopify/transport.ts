import type { FaultKind } from '@ryze/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { Faults, Site } from './state.js';

export interface TransportOptions {
  // Faults for sites registered without their own.
  faultRate: number;
  faultKinds: FaultKind[];
  random?: () => number;
  delays?: Partial<{ slowMs: [min: number, max: number]; timeoutHoldMs: number }>;
}

// Wrap endpoint handlers without sending their result, so a fault can drop the socket after a write.
export type SiteHandler = (site: Site, request: FastifyRequest, reply: FastifyReply) => unknown;
export type Route = (handler: SiteHandler) => RouteHandlerMethod;

export function createTransport(
  app: FastifyInstance,
  sites: Map<string, Site>,
  options: TransportOptions,
): Route {
  const random = options.random ?? Math.random;
  const [slowMin, slowMax] = options.delays?.slowMs ?? [2_000, 10_000];
  const timeoutHoldMs = options.delays?.timeoutHoldMs ?? 40_000;

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

  // With probability `rate` a write gets a fault, its kind drawn uniformly from `kinds`.
  const pickFault = ({ rate, kinds }: Faults): FaultKind | undefined =>
    kinds.length > 0 && random() < rate ? kinds[Math.floor(random() * kinds.length)] : undefined;

  // Writes can fail before or after taking effect; reads remain available for recovery lookups.
  const route: Route = (handler) => async (request, reply) => {
    const accessToken = request.headers['x-shopify-access-token'];

    const site = [...sites.values()].find(
      (item) => accessToken === `mock-${item.credentials.clientId}`,
    );

    if (!site) {
      reply.code(401);

      return { error: 'this route needs registered Shopify credentials' };
    }

    const query = (request.body as { query?: string })?.query ?? '';
    const write = /^\s*mutation\b/.test(query) && !query.includes('mutation StageCover');
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

  return route;
}
