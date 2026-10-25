import { Permanent } from '../utils/errors.js';
import { getJson, type Http, HttpError } from '../utils/http.js';
import type { PlatformAdapter, RemotePost, Site } from './types.js';

interface WpPost {
  id: number;
  status: string;
  link: string;
  meta?: { ryze_article_id?: string };
}
interface WpMedia {
  id: number;
  slug: string;
  source_url: string;
}

// WordPress REST API v2. site.base_url is the REST root: https://blog.example.com/wp-json for a
// real site, http://mock-wordpress:8092/wordpress for the mock. A token of the form
// "user:application password" is sent as Basic auth (real sites); any other token as Bearer.
export function createWordPress(http: Http): PlatformAdapter {
  const url = (site: Site, path: string) => `${site.base_url.replace(/\/+$/, '')}/wp/v2${path}`;

  const auth = (site: Site) => ({
    authorization: site.token.includes(':')
      ? `Basic ${Buffer.from(site.token).toString('base64')}`
      : `Bearer ${site.token}`,
  });

  const remote = (p: WpPost): RemotePost => ({
    id: String(p.id),
    status: p.status === 'publish' ? 'live' : 'draft',
    url: p.link,
    articleId: p.meta?.ryze_article_id ?? null,
  });

  const adapter: PlatformAdapter = {
    async verify(site, signal) {
      await http(url(site, '/users/me'), { headers: auth(site), signal });
    },

    // WordPress keeps duplicate uploads, so a retry must find the earlier one by its file name.
    async findMedia(site, filename, signal) {
      const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();

      const items = await getJson<WpMedia[]>(
        http,
        url(site, `/media?search=${encodeURIComponent(stem)}`),
        { headers: auth(site), signal },
      );

      const hit = items.find((m) => m.slug === stem || m.source_url.endsWith(`/${filename}`));

      return hit ? String(hit.id) : null;
    },

    async uploadMedia(site, filename, bytes, signal) {
      const media = await getJson<WpMedia>(http, url(site, '/media'), {
        signal,
        method: 'POST',
        headers: {
          ...auth(site),
          'content-type': 'image/jpeg',
          'content-disposition': `attachment; filename="${filename}"`,
        },
        body: bytes,
      });

      return String(media.id);
    },

    async findBySlug(site, slug, signal) {
      const posts = await getJson<WpPost[]>(
        http,
        url(site, `/posts?slug=${encodeURIComponent(slug)}&status=any&context=edit`),
        { headers: auth(site), signal },
      );

      return posts[0] ? remote(posts[0]) : null;
    },

    async createDraft(site, a, signal) {
      const post = {
        title: a.title,
        slug: a.slug,
        content: a.bodyHtml,
        status: 'draft',
        featured_media: Number(a.mediaId),
        meta: { ryze_article_id: a.articleId },
      };

      const create = (json: object) => {
        signal?.throwIfAborted();

        return getJson<WpPost>(http, url(site, '/posts'), {
          method: 'POST',
          headers: auth(site),
          json,
          signal,
        });
      };

      try {
        return String((await create(post)).id);
      } catch (err) {
        if (!(err instanceof HttpError)) {
          throw err;
        }

        // The slug is taken: an earlier attempt created this post. Adopt it.
        if (err.status === 409) {
          const found = await adapter.findBySlug(site, a.slug, signal);

          if (found) {
            if (found.articleId && found.articleId !== a.articleId) {
              throw new Permanent('slug belongs to another article');
            }

            return found.id;
          }
        }

        // A site without the ryze_article_id meta key registered rejects the field (nothing was
        // created): create the post without it; the slug alone identifies it then.
        if (err.status === 400 && err.message.includes('meta')) {
          const { meta: _meta, ...plain } = post;

          return String((await create(plain)).id);
        }

        throw err;
      }
    },

    async getStatus(site, postId, signal) {
      return remote(
        await getJson<WpPost>(http, url(site, `/posts/${postId}?context=edit`), {
          headers: auth(site),
          signal,
        }),
      );
    },

    async publish(site, postId, signal) {
      const post = await getJson<WpPost>(http, url(site, `/posts/${postId}`), {
        signal,
        method: 'POST',
        headers: auth(site),
        json: { status: 'publish' },
      });

      return post.link;
    },

    async deleteDraft(site, postId, signal) {
      await http(url(site, `/posts/${postId}?force=true`), {
        signal,
        method: 'DELETE',
        headers: auth(site),
      });
    },
  };

  return adapter;
}
