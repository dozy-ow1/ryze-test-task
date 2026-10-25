import { getJson, type Http, HttpError } from './http.js';
import type { PlatformAdapter, RemotePost, Site } from './types.js';

interface ShopifyArticle {
  id: number;
  handle: string;
  published: boolean;
  url: string | null;
}

// Shopify Admin REST 2026-10. site.base_url is the blog's API root:
// http://fake-platforms:8092/shopify/admin/api/2026-10/blogs/1 for the fake.
export function shopify(http: Http): PlatformAdapter {
  const blog = (site: Site) => site.base_url.replace(/\/+$/, '');
  const shop = (site: Site) => blog(site).replace(/\/blogs\/[^/]+$/, '');
  const auth = (site: Site) => ({ authorization: `Bearer ${site.token}` });
  const remote = (a: ShopifyArticle): RemotePost => ({
    id: String(a.id),
    status: a.published ? 'live' : 'draft',
    url: a.url ?? undefined,
  });

  const adapter: PlatformAdapter = {
    async verify(site) {
      await http(`${shop(site)}/shop.json`, { headers: auth(site) });
    },

    async findMedia(site, filename) {
      const { media } = await getJson<{ media: { id: number }[] }>(
        http,
        `${shop(site)}/media.json?filename=${encodeURIComponent(filename)}`,
        { headers: auth(site) },
      );
      return media[0] ? String(media[0].id) : null;
    },

    async uploadMedia(site, filename, bytes) {
      const { media } = await getJson<{ media: { id: number } }>(http, `${shop(site)}/media.json`, {
        method: 'POST',
        headers: auth(site),
        json: { filename, attachment: bytes.toString('base64') },
      });
      return String(media.id);
    },

    async findBySlug(site, slug) {
      const { articles } = await getJson<{ articles: ShopifyArticle[] }>(
        http,
        `${blog(site)}/articles.json?handle=${encodeURIComponent(slug)}`,
        { headers: auth(site) },
      );
      return articles[0] ? remote(articles[0]) : null;
    },

    async createDraft(site, a) {
      try {
        const { article } = await getJson<{ article: ShopifyArticle }>(
          http,
          `${blog(site)}/articles.json`,
          {
            method: 'POST',
            headers: auth(site),
            json: {
              article: {
                title: a.title,
                handle: a.slug,
                body_html: a.bodyHtml,
                published: false,
                image: { media_id: a.mediaId },
                metafields: [{ namespace: 'ryze', key: 'article_id', value: a.articleId }],
              },
            },
          },
        );
        return String(article.id);
      } catch (err) {
        // The handle is taken: an earlier attempt created this article. Adopt it.
        if (err instanceof HttpError && err.status === 422) {
          const found = await adapter.findBySlug(site, a.slug);
          if (found) return found.id;
        }
        throw err;
      }
    },

    async getStatus(site, postId) {
      const { article } = await getJson<{ article: ShopifyArticle }>(
        http,
        `${blog(site)}/articles/${postId}.json`,
        { headers: auth(site) },
      );
      return remote(article);
    },

    async publish(site, postId) {
      const { article } = await getJson<{ article: ShopifyArticle }>(
        http,
        `${blog(site)}/articles/${postId}.json`,
        { method: 'PUT', headers: auth(site), json: { article: { published: true } } },
      );
      return article.url ?? '';
    },

    async deleteDraft(site, postId) {
      await http(`${blog(site)}/articles/${postId}.json`, {
        method: 'DELETE',
        headers: auth(site),
      });
    },
  };
  return adapter;
}
