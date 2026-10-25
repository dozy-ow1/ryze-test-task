import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FAULT_KINDS, type FaultKind, IMAGE_PRICE_USD, llmCost } from '@ryze/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { writeArticle } from './content.js';

// Ranges are [min, max] in milliseconds; each wait is drawn uniformly from its range.
export interface Delays {
  textWorkMs: [number, number];
  jobReadyMs: [number, number];
  slowExtraMs: [number, number];
  timeoutHoldMs: number;
}

export interface GenerationOptions {
  faultRate: number;
  faultKinds: FaultKind[];
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

export function createRuntime(options: GenerationOptions) {
  const random = options.random ?? Math.random;
  const delays = { ...DEFAULT_DELAYS, ...options.delays };
  const between = ([min, max]: [number, number]) => min + random() * (max - min);
  let faults = { rate: options.faultRate, kinds: options.faultKinds };
  let counters = emptyCounters();
  const jobs = new Map<string, Job>();

  function pickFault(group: FaultGroup): FaultKind | undefined {
    if (faults.kinds.length === 0 || random() >= faults.rate) {
      return undefined;
    }

    const kind = faults.kinds[Math.floor(random() * faults.kinds.length)];
    counters.faults[group][kind] += 1;

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

    if (fault) {
      request.log.debug({ group, fault }, 'injecting fault');
    }

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

  return {
    withFaults,

    async generateText(brief: string) {
      await sleep(between(delays.textWorkMs));
      const article = writeArticle(brief);
      counters.text_calls += 1;
      counters.spend_usd += llmCost('mock', article.usage) ?? 0;

      return article;
    },

    async submitImage(prompt: string) {
      const job_id = randomUUID();
      jobs.set(job_id, { prompt, readyAt: Date.now() + between(delays.jobReadyMs) });
      counters.image_jobs += 1;
      counters.spend_usd += IMAGE_PRICE_USD;

      return { job_id };
    },

    getJob(id: string) {
      return jobs.get(id);
    },

    getCounters() {
      return { ...counters, spend_usd: Math.round(counters.spend_usd * 1e6) / 1e6 };
    },

    reset() {
      counters = emptyCounters();
      jobs.clear();
      faults = { rate: options.faultRate, kinds: options.faultKinds };
    },

    setFaults(value: { rate: number; kinds: FaultKind[] }) {
      faults = { rate: value.rate, kinds: [...new Set(value.kinds)] };

      return faults;
    },
  };
}

export type GenerationRuntime = ReturnType<typeof createRuntime>;
