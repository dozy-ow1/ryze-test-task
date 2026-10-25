import type { FastifyPluginAsync } from 'fastify';
import { renderImage } from './content.js';
import type { GenerationRuntime } from './runtime.js';

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

export const generationRoutes: FastifyPluginAsync<{ runtime: GenerationRuntime }> = async (
  app,
  { runtime },
) => {
  app.post<{ Body: { brief: string } }>('/text', { schema: { body: textBody } }, (request, reply) =>
    runtime.withFaults('text', request, reply, () => runtime.generateText(request.body.brief)),
  );
  app.post<{ Body: { prompt: string } }>(
    '/images',
    { schema: { body: imageBody } },
    (request, reply) =>
      runtime.withFaults('image_submit', request, reply, () =>
        runtime.submitImage(request.body.prompt),
      ),
  );

  app.get<{ Params: { job: string } }>('/images/:job', async (request, reply) => {
    const job = runtime.getJob(request.params.job);

    if (!job) {
      return reply.code(404).send({ error: 'unknown job' });
    }

    if (Date.now() < job.readyAt) {
      return { status: 'pending' };
    }

    return { status: 'done', url: `/v1/images/${request.params.job}/file` };
  });

  app.get<{ Params: { job: string } }>('/images/:job/file', async (request, reply) => {
    const job = runtime.getJob(request.params.job);

    if (!job) {
      return reply.code(404).send({ error: 'unknown job' });
    }

    if (Date.now() < job.readyAt) {
      return reply.code(409).send({ error: 'job not done yet' });
    }

    return reply.type('image/png').send(await renderImage(job.prompt));
  });
};
