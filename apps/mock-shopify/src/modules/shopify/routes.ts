import { SHOPIFY_API_VERSION, SHOPIFY_SCOPES } from '@ryze/core';
import type { FastifyPluginAsync } from 'fastify';
import type { Post, Site } from './state.js';
import type { Route } from './transport.js';

interface GraphqlBody {
  query: string;
  variables?: Record<string, unknown>;
}

function article(site: Site, post: Post) {
  return {
    id: post.id,
    handle: post.slug,
    isPublished: post.url !== null,
    blog: { id: site.credentials.blogId, handle: 'news' },
    metafield: post.articleId ? { value: post.articleId } : null,
  };
}

const failure = (field: string, code = 'INVALID') => ({
  article: null,
  files: [],
  userErrors: [{ code, field: [field], message: code }],
});

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
      const operation = query?.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      const origin = `${request.protocol}://${request.headers.host}`;
      const post = site.posts.find((item) => item.id === v.id);
      const shop = { primaryDomain: { url: origin } };

      const file = (item: Site['media'][number]) => ({
        id: item.id,
        alt: item.filename,
        createdAt: new Date().toISOString(),
        fileStatus: 'READY',
        image: { url: `${origin}/media/${site.credentials.clientId}/${item.filename}` },
      });

      switch (operation) {
        case 'VerifyPublisher':
        case 'PublisherSetup':
          return {
            data: {
              currentAppInstallation: {
                accessScopes: SHOPIFY_SCOPES.map((handle) => ({ handle })),
              },
              blog: v.id === site.credentials.blogId ? { id: site.credentials.blogId } : null,
            },
          };
        case 'PublisherBlogs':
          return {
            data: {
              blogs: {
                nodes: [{ id: site.credentials.blogId, title: 'News', handle: 'news' }],
                pageInfo: { hasNextPage: false },
              },
            },
          };
        case 'FindCover': {
          const filename = String(v.query).replace(/^filename:/, '');

          return {
            data: {
              files: { nodes: site.media.filter((item) => item.filename === filename).map(file) },
            },
          };
        }
        case 'StageCover': {
          const input = (v.input as { filename: string }[])[0];
          const url = `${origin}/uploads/${site.credentials.clientId}/${input.filename}`;

          return {
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{ url, resourceUrl: url, parameters: [] }],
                userErrors: [],
              },
            },
          };
        }
        case 'SaveCover': {
          const input = (v.files as { filename: string; originalSource: string }[])[0];

          if (site.media.some((item) => item.filename === input.filename)) {
            return { data: { fileCreate: failure('filename', 'FILENAME_ALREADY_EXISTS') } };
          }

          const bytes = site.uploads.get(input.filename);

          if (!bytes) {
            return { data: { fileCreate: failure('originalSource') } };
          }

          const item = {
            id: `gid://shopify/MediaImage/${++site.lastId}`,
            filename: input.filename,
            bytes,
          };
          site.media.push(item);
          site.uploads.delete(input.filename);

          return { data: { fileCreate: { files: [file(item)], userErrors: [] } } };
        }
        case 'CoverStatus': {
          const item = site.media.find((item) => item.id === v.id);

          return { data: { node: item ? file(item) : null } };
        }
        case 'FindArticle': {
          const slug = /handle:("(?:\\.|[^"])*")/.exec(String(v.query))?.[1];

          return {
            data: {
              articles: {
                nodes: site.posts
                  .filter((item) => slug && item.slug === JSON.parse(slug))
                  .map((item) => article(site, item)),
              },
              shop,
            },
          };
        }
        case 'CreateDraft': {
          const input = v.article as {
            blogId: string;
            title: string;
            handle: string;
            body: string;
            image: { url: string };
            metafields: { value: string }[];
          };

          const media = site.media.find((item) => file(item).image.url === input.image.url);

          if (
            input.blogId !== site.credentials.blogId ||
            !media ||
            site.posts.some((item) => item.slug === input.handle)
          ) {
            return { data: { articleCreate: failure('article') } };
          }

          const created: Post = {
            id: `gid://shopify/Article/${++site.lastId}`,
            slug: input.handle,
            title: input.title,
            content: input.body,
            mediaId: media.id,
            articleId: input.metafields[0]?.value ?? null,
            url: null,
          };
          site.posts.push(created);

          return { data: { articleCreate: { article: article(site, created), userErrors: [] } } };
        }
        case 'ArticleStatus':
          return { data: { article: post ? article(site, post) : null, shop } };
        case 'PublishArticle':
          if (!post) {
            return { data: { articleUpdate: failure('id') } };
          }

          post.url = `${origin}/blogs/news/${post.slug}`;
          return { data: { articleUpdate: { article: article(site, post), userErrors: [] } } };
        case 'DeleteDraft':
          if (!post || post.url) {
            return { data: { articleDelete: failure('id') } };
          }

          site.posts.splice(site.posts.indexOf(post), 1);
          return { data: { articleDelete: { deletedArticleId: post.id, userErrors: [] } } };
        default:
          return reply.code(400).send({ error: 'unsupported mock GraphQL operation' });
      }
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
