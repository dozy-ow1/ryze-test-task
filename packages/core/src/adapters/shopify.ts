import { type Http, HttpError, type HttpRequest } from './http.js';
import type { PlatformAdapter, RemotePost, Site } from './types.js';

interface ShopifyArticle {
  id: number;
  handle: string;
  published?: boolean; // the fake
  published_at?: string | null; // a real store
  url?: string | null; // the fake
}

// Shopify Admin REST 2026-10. site.base_url is the blog's API root:
//   real store: https://<store>.myshopify.com/admin/api/2026-10/blogs/<blog id>, token sent as
//     X-Shopify-Access-Token. Articles take the cover inline, so there is no media library:
//     uploadMedia only names the file and createDraft sends the bytes.
//   the fake:   http://fake-platforms:8092/shopify/admin/api/2026-10/blogs/1, Bearer token, with a
//     media library (media.json) like the spec's fake.
// A real store reports its leaky bucket on every answer (X-Shopify-Shop-Api-Call-Limit: used/max);
// onCallLimit lets the worker bring the site's quota row in line with it.
export function shopify(
  http: Http,
  onCallLimit?: (site: Site, available: number) => Promise<void>,
): PlatformAdapter {
  const blog = (site: Site) => site.base_url.replace(/\/+$/, '');
  const shop = (site: Site) => blog(site).replace(/\/blogs\/[^/]+$/, '');
  const real = (site: Site) => new URL(site.base_url).hostname.endsWith('.myshopify.com');
  const publicBlog = new Map<string, Promise<string>>(); // site id → https://<domain>/blogs/<handle>

  async function call<T>(site: Site, url: string, req: HttpRequest = {}): Promise<T> {
    const auth: Record<string, string> = real(site)
      ? { 'x-shopify-access-token': site.token }
      : { authorization: `Bearer ${site.token}` };
    const res = await http(url, { ...req, headers: { ...auth, ...req.headers } });
    const limit = res.headers['x-shopify-shop-api-call-limit'];
    if (onCallLimit && typeof limit === 'string') {
      const [used, max] = limit.split('/').map(Number);
      if (Number.isFinite(used) && Number.isFinite(max)) await onCallLimit(site, max - used);
    }
    return JSON.parse(res.body.toString('utf8') || 'null') as T;
  }

  // A real article has no URL field: it is the shop's domain, the blog's handle and its own.
  async function urlOf(site: Site, a: ShopifyArticle): Promise<string | undefined> {
    if (!real(site)) return a.url ?? undefined;
    let root = publicBlog.get(site.id);
    if (!root) {
      root = Promise.all([
        call<{ shop: { domain: string } }>(site, `${shop(site)}/shop.json`),
        call<{ blog: { handle: string } }>(site, `${blog(site)}.json`),
      ]).then(([s, b]) => `https://${s.shop.domain}/blogs/${b.blog.handle}`);
      root.catch(() => publicBlog.delete(site.id));
      publicBlog.set(site.id, root);
    }
    return `${await root}/${a.handle}`;
  }

  const live = (a: ShopifyArticle) => a.published ?? Boolean(a.published_at);
  const remote = async (site: Site, a: ShopifyArticle): Promise<RemotePost> => ({
    id: String(a.id),
    status: live(a) ? 'live' : 'draft',
    url: live(a) ? await urlOf(site, a) : undefined,
  });

  const adapter: PlatformAdapter = {
    async verify(site) {
      await call(site, `${shop(site)}/shop.json`);
    },

    async findMedia(site, filename) {
      if (real(site)) return null;
      const { media } = await call<{ media: { id: number }[] }>(
        site,
        `${shop(site)}/media.json?filename=${encodeURIComponent(filename)}`,
      );
      return media[0] ? String(media[0].id) : null;
    },

    async uploadMedia(site, filename, bytes) {
      if (real(site)) return filename; // the bytes go inline with the article
      const { media } = await call<{ media: { id: number } }>(site, `${shop(site)}/media.json`, {
        method: 'POST',
        json: { filename, attachment: bytes.toString('base64') },
      });
      return String(media.id);
    },

    async findBySlug(site, slug) {
      const { articles } = await call<{ articles: ShopifyArticle[] }>(
        site,
        `${blog(site)}/articles.json?handle=${encodeURIComponent(slug)}`,
      );
      return articles[0] ? remote(site, articles[0]) : null;
    },

    async createDraft(site, a) {
      const image = real(site)
        ? { attachment: (await a.image()).toString('base64'), filename: a.mediaId }
        : { media_id: a.mediaId };
      try {
        const { article } = await call<{ article: ShopifyArticle }>(
          site,
          `${blog(site)}/articles.json`,
          {
            method: 'POST',
            json: {
              article: {
                title: a.title,
                handle: a.slug,
                body_html: a.bodyHtml,
                published: false,
                image,
                metafields: [
                  {
                    namespace: 'ryze',
                    key: 'article_id',
                    value: a.articleId,
                    type: 'single_line_text_field',
                  },
                ],
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
      const { article } = await call<{ article: ShopifyArticle }>(
        site,
        `${blog(site)}/articles/${postId}.json`,
      );
      return remote(site, article);
    },

    async publish(site, postId) {
      const { article } = await call<{ article: ShopifyArticle }>(
        site,
        `${blog(site)}/articles/${postId}.json`,
        { method: 'PUT', json: { article: { published: true } } },
      );
      return (await urlOf(site, { ...article, published: true })) ?? '';
    },

    async deleteDraft(site, postId) {
      await call(site, `${blog(site)}/articles/${postId}.json`, { method: 'DELETE' });
    },
  };
  return adapter;
}
