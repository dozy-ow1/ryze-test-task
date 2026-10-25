import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  addMedia,
  addPost,
  findPost,
  type Media,
  type Post,
  type Route,
  removePost,
} from './sites.js';

// The Shopify Admin REST API routes the worker's adapter calls, mounted under
// /shopify/admin/api/2026-10. A site has a single blog, which every numeric blog id reaches.

const createMediaBody = {
  type: 'object',
  required: ['filename', 'attachment'],
  properties: {
    filename: { type: 'string', minLength: 1 },
    attachment: { type: 'string', minLength: 1 }, // base64; the fake does not keep the bytes
  },
};

const createArticleBody = {
  type: 'object',
  required: ['article'],
  properties: {
    article: {
      type: 'object',
      required: ['handle'],
      properties: {
        title: { type: 'string' },
        handle: { type: 'string', minLength: 1 },
        body_html: { type: 'string' },
        published: { type: 'boolean' },
        image: { type: ['object', 'null'], properties: { media_id: { type: 'integer' } } },
        metafields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['namespace', 'key', 'value'],
            properties: {
              namespace: { type: 'string' },
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

interface CreateArticle {
  title?: string;
  handle: string;
  body_html?: string;
  published?: boolean;
  image?: { media_id?: number } | null;
  metafields?: { namespace: string; key: string; value: string }[];
}

// Publishing is the only update the fake supports.
const updateArticleBody = {
  type: 'object',
  required: ['article'],
  properties: {
    article: {
      type: 'object',
      required: ['published'],
      properties: { published: { type: 'boolean', const: true } },
    },
  },
};

const articlesPath = '/blogs/:blog(^\\d+)/articles.json';
const articlePath = '/blogs/:blog(^\\d+)/articles/:id(^\\d+).json';

export function shopifyRoutes(app: FastifyInstance, route: Route): void {
  app.get(
    '/shop.json',
    route(() => ({ shop: { id: 1, name: 'Ryze Demo Shop' } })),
  );

  app.get(
    '/media.json',
    route((site, request) => {
      const { filename } = request.query as { filename?: string };
      const media = site.media.filter((m) => filename === undefined || m.filename === filename);
      return { media: media.map(renderMedia) };
    }),
  );

  app.post(
    '/media.json',
    { schema: { body: createMediaBody } },
    route((site, request, reply) => {
      const { filename } = request.body as { filename: string };
      reply.code(201);
      return { media: renderMedia(addMedia(site, filename)) };
    }),
  );

  app.get(
    articlesPath,
    route((site, request) => {
      const { handle } = request.query as { handle?: string };
      const matching = site.posts.filter((p) => handle === undefined || p.slug === handle);
      return { articles: matching.map(renderArticle) };
    }),
  );

  app.get(
    articlePath,
    route((site, request, reply) => {
      const article = findPost(site, (request.params as { id: string }).id);
      return article ? { article: renderArticle(article) } : notFound(reply);
    }),
  );

  app.post(
    articlesPath,
    { schema: { body: createArticleBody } },
    route((site, request, reply) => {
      const input = (request.body as { article: CreateArticle }).article;
      const mediaId = input.image?.media_id ?? null;
      if (mediaId !== null && !site.media.some((m) => m.id === mediaId)) {
        return invalid(reply, 'image', 'media_id does not exist');
      }
      if (site.posts.some((p) => p.slug === input.handle)) {
        return invalid(reply, 'handle', 'has already been taken');
      }
      const ryze = input.metafields?.find((m) => m.namespace === 'ryze' && m.key === 'article_id');
      const created = addPost(site, {
        slug: input.handle,
        title: input.title ?? '',
        content: input.body_html ?? '',
        mediaId,
        articleId: ryze?.value ?? null,
        url: input.published ? publicUrl(request.host, input.handle) : null,
      });
      reply.code(201);
      return { article: renderArticle(created) };
    }),
  );

  // Publishing a live article changes nothing and returns it, so a retried publish is harmless.
  app.put(
    articlePath,
    { schema: { body: updateArticleBody } },
    route((site, request, reply) => {
      const article = findPost(site, (request.params as { id: string }).id);
      if (!article) return notFound(reply);
      article.url ??= publicUrl(request.host, article.slug);
      return { article: renderArticle(article) };
    }),
  );

  app.delete(
    articlePath,
    route((site, request, reply) => {
      const article = findPost(site, (request.params as { id: string }).id);
      if (!article) return notFound(reply);
      removePost(site, article);
      return {};
    }),
  );
}

function renderMedia(media: Media) {
  return { id: media.id, filename: media.filename };
}

function renderArticle(post: Post) {
  return {
    id: post.id,
    title: post.title,
    handle: post.slug,
    body_html: post.content,
    published: post.url !== null,
    url: post.url,
    image: post.mediaId === null ? null : { media_id: post.mediaId },
    metafields:
      post.articleId === null
        ? []
        : [{ namespace: 'ryze', key: 'article_id', value: post.articleId }],
  };
}

function publicUrl(host: string, handle: string): string {
  return `http://${host}/shopify/blogs/news/${handle}`;
}

function invalid(reply: FastifyReply, field: string, message: string) {
  reply.code(422);
  return { errors: { [field]: [message] } };
}

function notFound(reply: FastifyReply) {
  reply.code(404);
  return { errors: 'Not Found' };
}
