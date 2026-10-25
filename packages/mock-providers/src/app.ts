import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FAULT_KINDS, type FaultKind, IMAGE_PRICE_USD, llmCost } from '@ryze/core';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, LogController } from 'fastify';
import { renderImage, writeArticle } from './content.js';

// Ranges are [min, max] in milliseconds; each wait is drawn uniformly from its range.
export interface Delays {
  textWorkMs: [number, number];
  jobReadyMs: [number, number];
  slowExtraMs: [number, number];
  timeoutHoldMs: number;
}

export interface AppOptions {
  faultRate: number;
  faultKinds: FaultKind[];
  logLevel?: string;
  random?: () => number;
  delays?: Partial<Delays>;
}

const DEFAULT_DELAYS: Delays = {
  textWorkMs: [200, 800],
  jobReadyMs: [2_000, 5_000],
  slowExtraMs: [2_000, 10_000],
  timeoutHoldMs: 40_000,
};

type FaultGroup = 'text' | 'image_submit';

interface Job {
  prompt: string;
  readyAt: number;
}

const textBody = {
  type: 'object',
  required: ['brief'],
  properties: { brief: { type: 'string', minLength: 1 } },
};

const imageBody = {
  type: 'object',
  required: ['prompt'],
  properties: { prompt: { type: 'string', minLength: 1 } },
};

const faultsBody = {
  type: 'object',
  required: ['rate', 'kinds'],
  properties: {
    rate: { type: 'number', minimum: 0, maximum: 1 },
    kinds: { type: 'array', items: { type: 'string', enum: FAULT_KINDS } },
  },
};

function emptyCounters() {
  const noFaults = () =>
    Object.fromEntries(FAULT_KINDS.map((kind) => [kind, 0])) as Record<FaultKind, number>;

  return {
    text_calls: 0,
    image_jobs: 0,
    spend_usd: 0,
    faults: { text: noFaults(), image_submit: noFaults() },
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const random = options.random ?? Math.random;
  const delays = { ...DEFAULT_DELAYS, ...options.delays };
  const between = ([min, max]: [number, number]) => min + random() * (max - min);

  let faults = { rate: options.faultRate, kinds: options.faultKinds };
  let counters = emptyCounters();
  const jobs = new Map<string, Job>();

  const app = Fastify({
    logger: { name: 'mock-providers', level: options.logLevel ?? 'silent' },
    logController: new LogController({ disableRequestLogging: true }),
    // Otherwise close() waits for held (`timeout`) sockets and for calls still mid-work.
    forceCloseConnections: true,
  });

  function pickFault(group: FaultGroup): FaultKind | undefined {
    if (faults.kinds.length === 0 || random() >= faults.rate) {
      return undefined;
    }

    const kind = faults.kinds[Math.floor(random() * faults.kinds.length)];
    counters.faults[group][kind] += 1;
    app.log.debug({ group, fault: kind }, 'injecting fault');

    return kind;
  }

  // Runs a paid call under fault injection. `work` does the job and counts its spend; it runs to the
  // end even if the client has gone away meanwhile, because a real provider would still bill it.
  async function withFaults(
    group: FaultGroup,
    request: FastifyRequest,
    reply: FastifyReply,
    work: () => Promise<object>,
  ) {
    const fault = pickFault(group);

    if (fault === '429') {
      return reply.code(429).header('retry-after', '2').send({ error: 'rate limited' });
    }

    if (fault === '500') {
      return reply.code(500).send({ error: 'internal error' });
    }

    if (fault === 'timeout') {
      // Never answer; cut the socket when the hold is over (the client should give up first).
      reply.hijack();
      const socket = request.raw.socket;
      const timer = setTimeout(() => socket.destroy(), delays.timeoutHoldMs);
      socket.once('close', () => clearTimeout(timer));

      return reply;
    }

    if (fault === 'slow') {
      await sleep(between(delays.slowExtraMs));
    }

    const result = await work();

    if (fault === 'complete_then_drop') {
      reply.hijack();
      request.raw.socket.destroy();

      return reply;
    }

    return result;
  }

  app.post<{ Body: { brief: string } }>(
    '/v1/text',
    { schema: { body: textBody } },
    (request, reply) =>
      withFaults('text', request, reply, async () => {
        await sleep(between(delays.textWorkMs));
        const article = writeArticle(request.body.brief);
        counters.text_calls += 1;
        counters.spend_usd += llmCost('mock', article.usage) ?? 0;

        return article;
      }),
  );

  app.post<{ Body: { prompt: string } }>(
    '/v1/images',
    { schema: { body: imageBody } },
    (request, reply) =>
      withFaults('image_submit', request, reply, async () => {
        const job_id = randomUUID();
        jobs.set(job_id, {
          prompt: request.body.prompt,
          readyAt: Date.now() + between(delays.jobReadyMs),
        });
        counters.image_jobs += 1;
        counters.spend_usd += IMAGE_PRICE_USD;

        return { job_id };
      }),
  );

  app.get<{ Params: { job: string } }>('/v1/images/:job', async (request, reply) => {
    const job = jobs.get(request.params.job);

    if (!job) {
      return reply.code(404).send({ error: 'unknown job' });
    }

    if (Date.now() < job.readyAt) {
      return { status: 'pending' };
    }

    return { status: 'done', url: `/v1/images/${request.params.job}/file` };
  });

  app.get<{ Params: { job: string } }>('/v1/images/:job/file', async (request, reply) => {
    const job = jobs.get(request.params.job);

    if (!job) {
      return reply.code(404).send({ error: 'unknown job' });
    }

    if (Date.now() < job.readyAt) {
      return reply.code(409).send({ error: 'job not done yet' });
    }

    return reply.type('image/png').send(await renderImage(job.prompt));
  });

  app.get('/_admin/counters', async () => ({
    ...counters,
    spend_usd: Math.round(counters.spend_usd * 1e6) / 1e6,
  }));

  app.post('/_admin/reset', async () => {
    counters = emptyCounters();
    jobs.clear();
    faults = { rate: options.faultRate, kinds: options.faultKinds };

    return { ok: true };
  });

  app.post<{ Body: { rate: number; kinds: FaultKind[] } }>(
    '/_admin/faults',
    { schema: { body: faultsBody } },
    async (request) => {
      faults = { rate: request.body.rate, kinds: [...new Set(request.body.kinds)] };

      return faults;
    },
  );

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
