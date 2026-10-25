import { FAULT_KINDS } from '@ryze/core';
import type { FastifyPluginAsync } from 'fastify';
import { type Faults, newSite, type Site } from '../wordpress/state.js';
import type { TransportOptions } from '../wordpress/transport.js';

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

export const adminRoutes: FastifyPluginAsync<{
  sites: Map<string, Site>;
  defaults: TransportOptions;
}> = async (app, { sites, defaults }) => {
  // Registering a known token again updates its faults and keeps its data.
  app.post('/sites', { schema: { body: registerSiteBody } }, async (request, reply) => {
    const { token, platform, faults } = request.body as RegisterSite;

    const effective: Faults = {
      rate: faults?.rate ?? defaults.faultRate,
      kinds: faults?.kinds ?? defaults.faultKinds,
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
  app.get('/inspect', async () => ({
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

  app.post('/reset', async () => {
    sites.clear();

    return { ok: true };
  });
};
