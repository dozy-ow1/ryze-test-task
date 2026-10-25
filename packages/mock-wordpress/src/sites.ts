import type { FaultKind } from '@ryze/core';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

// What the mock keeps in memory for each registered site token.

export interface Faults {
  rate: number;
  kinds: FaultKind[];
}

export interface Media {
  id: number;
  filename: string; // as uploaded: ryze-<article uuid>.jpg
  // WordPress's slug for the upload: the lowercased file stem, then
  // <stem>-2, <stem>-3, ... when the same name is uploaded again.
  slug: string;
}

// In-memory WordPress post state.
export interface Post {
  id: number;
  slug: string;
  title: string;
  content: string;
  mediaId: number | null;
  articleId: string | null; // meta.ryze_article_id
  // Public URL, set when the post goes live (null while it is a draft). It is built from the Host of
  // the publishing request and kept, so inspect reports the URL the publisher was given.
  url: string | null;
}

export interface Site {
  token: string;
  platform: 'wordpress';
  faults: Faults;
  faultsInjected: Record<FaultKind, number>;
  lastId: number; // media and posts share one id sequence per site
  media: Media[];
  posts: Post[];
}

// A platform route handler. It runs once auth and fault injection have let the request through,
// sets the status with reply.code() and returns the body. It never calls reply.send(), so that a
// complete_then_drop fault can still drop the connection after the write.
export type SiteHandler = (site: Site, request: FastifyRequest, reply: FastifyReply) => unknown;
export type Route = (handler: SiteHandler) => RouteHandlerMethod;

export function newSite(token: string, faults: Faults): Site {
  return {
    token,
    platform: 'wordpress',
    faults,
    faultsInjected: { '429': 0, '500': 0, timeout: 0, slow: 0, complete_then_drop: 0 },
    lastId: 1000,
    media: [],
    posts: [],
  };
}

// Uploading a name again creates a second item, as on the real platforms.
export function addMedia(site: Site, filename: string): Media {
  const stem = filename.replace(/\.[^.]*$/, '').toLowerCase();
  let slug = stem;

  for (let n = 2; site.media.some((m) => m.slug === slug); n++) {
    slug = `${stem}-${n}`;
  }

  const media = { id: ++site.lastId, filename, slug };
  site.media.push(media);

  return media;
}

export function addPost(site: Site, fields: Omit<Post, 'id'>): Post {
  const post = { id: ++site.lastId, ...fields };
  site.posts.push(post);

  return post;
}

export function findPost(site: Site, id: string): Post | undefined {
  return site.posts.find((p) => p.id === Number(id));
}

export function removePost(site: Site, post: Post): void {
  site.posts.splice(site.posts.indexOf(post), 1);
}
