import { SHOPIFY_API_VERSION, SHOPIFY_SCOPES } from '@ryze/shared';
import type { FastifyPluginAsync } from 'fastify';
import { executeOperation } from './operations.js';
import type { Site } from './state.js';
import type { Route } from './transport.js';

interface GraphqlBody {
  query: string;
  variables?: Record<string, unknown>;
}

export const shopifyRoutes: FastifyPluginAsync<{ sites: Map<string, Site>; route: Route }> = async (
  app,
  { sites, route },
) => {
  app.post('/admin/oauth/access_token', async (request, reply) => {
    const body = request.body as {
      client_id?: string;
      client_secret?: string;
      grant_type?: string;
    };

    const site = [...sites.values()].find(
      (item) =>
        item.credentials.clientId === body.client_id &&
        item.credentials.clientSecret === body.client_secret,
    );

    if (!site || body.grant_type !== 'client_credentials') {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    return {
      access_token: `mock-${site.credentials.clientId}`,
      expires_in: 86399,
      scope: SHOPIFY_SCOPES.join(','),
    };
  });

  app.post(
    `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    route(async (site, request, reply) => {
      const { query, variables: v = {} } = request.body as GraphqlBody;
      const origin = `${request.protocol}://${request.headers.host}`;
      const result = executeOperation(site, query, v, origin);

      return result ?? reply.code(400).send({ error: 'unsupported mock GraphQL operation' });
    }),
  );

  app.post<{ Params: { clientId: string; filename: string } }>(
    '/uploads/:clientId/:filename',
    async (request, reply) => {
      const site = [...sites.values()].find(
        (item) => item.credentials.clientId === request.params.clientId,
      );

      const body = request.body;

      if (!site || !Buffer.isBuffer(body)) {
        return reply.code(400).send({ error: 'invalid upload' });
      }

      const start = body.indexOf('\r\n\r\n');
      const end = body.lastIndexOf('\r\n--');

      if (start < 0 || end <= start + 4) {
        return reply.code(400).send({ error: 'invalid multipart body' });
      }

      site.uploads.set(request.params.filename, body.subarray(start + 4, end));

      return reply.code(204).send();
    },
  );

  app.get<{ Params: { clientId: string; filename: string } }>(
    '/media/:clientId/:filename',
    async (request, reply) => {
      const site = [...sites.values()].find(
        (item) => item.credentials.clientId === request.params.clientId,
      );

      const item = site?.media.find((media) => media.filename === request.params.filename);

      return item ? reply.type('image/jpeg').send(item.bytes) : reply.code(404).send();
    },
  );
};
