import { getJson, type Http, HttpError } from './http.js';
import type { PlatformAdapter, RemotePost, Site } from './types.js';

interface WpPost {
  id: number;
  status: string;
  link: string;
}
interface WpMedia {
  id: number;
  slug: string;
  source_url: string;
}

// WordPress REST API v2. site.base_url is the REST root: https://blog.example.com/wp-json for a
// real site, http://fake-platforms:8092/wordpress for the fake. A token of the form
// "user:application password" is sent as Basic auth (real sites); any other token as Bearer.
export function wordpress(http: Http): PlatformAdapter {
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
  });

  const adapter: PlatformAdapter = {
    async verify(site) {
      await http(url(site, '/users/me'), { headers: auth(site) });
    },

    // WordPress keeps duplicate uploads, so a retry must find the earlier one by its file name.
    async findMedia(site, filename) {
      const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
      const items = await getJson<WpMedia[]>(
        http,
        url(site, `/media?search=${encodeURIComponent(stem)}`),
        { headers: auth(site) },
      );
      const hit = items.find((m) => m.slug === stem || m.source_url.endsWith(`/${filename}`));
      return hit ? String(hit.id) : null;
    },

    async uploadMedia(site, filename, bytes) {
      const media = await getJson<WpMedia>(http, url(site, '/media'), {
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

    async findBySlug(site, slug) {
      const posts = await getJson<WpPost[]>(
        http,
        url(site, `/posts?slug=${encodeURIComponent(slug)}&status=any&context=edit`),
        { headers: auth(site) },
      );
      return posts[0] ? remote(posts[0]) : null;
    },

    async createDraft(site, a) {
      try {
        const post = await getJson<WpPost>(http, url(site, '/posts'), {
          method: 'POST',
          headers: auth(site),
          json: {
            title: a.title,
            slug: a.slug,
            content: a.bodyHtml,
            status: 'draft',
            featured_media: Number(a.mediaId),
            meta: { ryze_article_id: a.articleId },
          },
        });
        return String(post.id);
      } catch (err) {
        // The slug is taken: an earlier attempt created this post. Adopt it.
        if (err instanceof HttpError && err.status === 409) {
          const found = await adapter.findBySlug(site, a.slug);
          if (found) return found.id;
        }
        throw err;
      }
    },

    async getStatus(site, postId) {
      return remote(
        await getJson<WpPost>(http, url(site, `/posts/${postId}?context=edit`), {
          headers: auth(site),
        }),
      );
    },

    async publish(site, postId) {
      const post = await getJson<WpPost>(http, url(site, `/posts/${postId}`), {
        method: 'POST',
        headers: auth(site),
        json: { status: 'publish' },
      });
      return post.link;
    },

    async deleteDraft(site, postId) {
      await http(url(site, `/posts/${postId}?force=true`), {
        method: 'DELETE',
        headers: auth(site),
      });
    },
  };
  return adapter;
}
