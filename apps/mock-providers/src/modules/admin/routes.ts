import { FAULT_KINDS, type FaultKind } from '@ryze/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { GenerationRuntime } from '../generation/runtime.js';

const faultsBody = {
  type: 'object',
  required: ['rate', 'kinds'],
  properties: {
    rate: { type: 'number', minimum: 0, maximum: 1 },
    kinds: { type: 'array', items: { type: 'string', enum: FAULT_KINDS } },
  },
};

export const adminRoutes: FastifyPluginAsync<{ runtime: GenerationRuntime }> = async (
  app,
  { runtime },
) => {
  app.get('/counters', async () => runtime.getCounters());
  app.post('/reset', async () => {
    runtime.reset();

    return { ok: true };
  });
  app.post<{ Body: { rate: number; kinds: FaultKind[] } }>(
    '/faults',
    { schema: { body: faultsBody } },
    async (request) => runtime.setFaults(request.body),
  );
};
