import { extname } from 'node:path';
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

// The WordPress REST API routes the worker's adapter calls, mounted under /wordpress/wp/v2.

const createPostBody = {
  type: 'object',
  required: ['slug'],
  properties: {
    title: { type: 'string' },
    slug: { type: 'string', minLength: 1 },
    content: { type: 'string' },
    status: { enum: ['draft', 'publish'] },
    featured_media: { type: 'integer', minimum: 0 },
    meta: { type: 'object', properties: { ryze_article_id: { type: 'string' } } },
  },
};

interface CreatePost {
  title?: string;
  slug: string;
  content?: string;
  status?: 'draft' | 'publish';
  featured_media?: number;
  meta?: { ryze_article_id?: string };
}

// Publishing is the only update the fake supports.
const updatePostBody = {
  type: 'object',
  required: ['status'],
  properties: { status: { const: 'publish' } },
};

const postPath = '/posts/:id(^\\d+)';

export function wordpressRoutes(app: FastifyInstance, route: Route): void {
  app.get(
    '/users/me',
    route(() => ({ id: 1, name: 'ryze-editor' })),
  );

  app.get(
    '/media',
    route((site, request) => {
      const search = ((request.query as { search?: string }).search ?? '').toLowerCase();
      return site.media
        .filter((m) => m.slug.includes(search))
        .map((m) => renderMedia(m, request.host));
    }),
  );

  // The body is the raw image; the name comes from Content-Disposition.
  app.post(
    '/media',
    route((site, request, reply) => {
      const disposition = request.headers['content-disposition'] ?? '';
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      if (!filename) {
        return error(reply, 400, 'rest_upload_no_filename', 'Content-Disposition has no filename.');
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return error(reply, 400, 'rest_upload_no_data', 'No data supplied.');
      }
      reply.code(201);
      return renderMedia(addMedia(site, filename), request.host);
    }),
  );

  // Like WordPress, only published posts are listed unless the query asks for other statuses
  // (status=any, or a comma-separated list).
  app.get(
    '/posts',
    route((site, request) => {
      const { slug, status = 'publish' } = request.query as { slug?: string; status?: string };
      const statuses = status.split(',');
      return site.posts
        .filter((p) => slug === undefined || p.slug === slug)
        .filter((p) => statuses.includes('any') || statuses.includes(statusOf(p)))
        .map((p) => renderPost(p, request.host));
    }),
  );

  app.get(
    postPath,
    route((site, request, reply) => {
      const post = findPost(site, (request.params as { id: string }).id);
      return post ? renderPost(post, request.host) : notFound(reply);
    }),
  );

  app.post(
    '/posts',
    { schema: { body: createPostBody } },
    route((site, request, reply) => {
      const body = request.body as CreatePost;
      const mediaId = body.featured_media || null; // 0 means no featured image
      if (mediaId !== null && !site.media.some((m) => m.id === mediaId)) {
        return error(reply, 400, 'rest_invalid_featured_media', 'Invalid featured media ID.');
      }
      // The real WordPress would save the post as <slug>-2. The fake refuses, so that a second
      // draft for the same article is an error the pipeline has to handle, not a silent duplicate.
      if (site.posts.some((p) => p.slug === body.slug)) {
        return error(reply, 409, 'slug_exists', `A post with slug "${body.slug}" already exists.`);
      }
      const created = addPost(site, {
        slug: body.slug,
        title: body.title ?? '',
        content: body.content ?? '',
        mediaId,
        articleId: body.meta?.ryze_article_id ?? null,
        url: body.status === 'publish' ? publicUrl(request.host, body.slug) : null,
      });
      reply.code(201);
      return renderPost(created, request.host);
    }),
  );

  // Publishing a live post changes nothing and returns it, so a retried publish is harmless.
  app.post(
    postPath,
    { schema: { body: updatePostBody } },
    route((site, request, reply) => {
      const post = findPost(site, (request.params as { id: string }).id);
      if (!post) return notFound(reply);
      post.url ??= publicUrl(request.host, post.slug);
      return renderPost(post, request.host);
    }),
  );

  // Always a permanent delete, whether or not the query says force=true.
  app.delete(
    postPath,
    route((site, request, reply) => {
      const post = findPost(site, (request.params as { id: string }).id);
      if (!post) return notFound(reply);
      removePost(site, post);
      return { deleted: true, previous: renderPost(post, request.host) };
    }),
  );
}

function renderMedia(media: Media, host: string) {
  const file = `${media.slug}${extname(media.filename)}`;
  return { id: media.id, slug: media.slug, source_url: `http://${host}/wordpress/uploads/${file}` };
}

function renderPost(post: Post, host: string) {
  return {
    id: post.id,
    slug: post.slug,
    status: statusOf(post),
    link: post.url ?? `http://${host}/wordpress/?p=${post.id}`,
    title: { rendered: post.title },
    content: { rendered: post.content },
    featured_media: post.mediaId ?? 0,
    meta: { ryze_article_id: post.articleId ?? '' },
  };
}

function statusOf(post: Post): 'draft' | 'publish' {
  return post.url === null ? 'draft' : 'publish';
}

function publicUrl(host: string, slug: string): string {
  return `http://${host}/wordpress/blog/${slug}`;
}

function error(reply: FastifyReply, status: number, code: string, message: string) {
  reply.code(status);
  return { code, message, data: { status } };
}

function notFound(reply: FastifyReply) {
  return error(reply, 404, 'rest_post_invalid_id', 'Invalid post ID.');
}
