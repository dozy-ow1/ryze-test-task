import { Permanent } from '../quota.js';
import { type Http, HttpError, type HttpRequest } from './http.js';
import type { PlatformAdapter, RemotePost, Site } from './types.js';

interface ShopifyArticle {
  id: number;
  handle: string;
  published?: boolean; // the fake
  published_at?: string | null; // a real store
  url?: string | null; // the fake
  article_id?: string;
  metafields?: { namespace: string; key: string; value: string }[];
}

// Shopify Admin REST. The site URL points at one blog's API root. Cover images are attached
// inline when creating an article; there is no independent media-library API for blog covers.
export function createShopify(
  http: Http,
  onCallLimit?: (site: Site, available: number) => Promise<void>,
): PlatformAdapter {
  const blog = (site: Site) => site.base_url.replace(/\/+$/, '');
  const shop = (site: Site) => blog(site).replace(/\/blogs\/[^/]+$/, '');
  const publicBlog = new Map<string, Promise<string>>(); // site id → https://<domain>/blogs/<handle>

  async function call<T>(
    site: Site,
    url: string,
    req: HttpRequest = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const auth = { 'x-shopify-access-token': site.token };
    signal?.throwIfAborted();
    const res = await http(url, { ...req, signal, headers: { ...auth, ...req.headers } });
    const limit = res.headers['x-shopify-shop-api-call-limit'];
    if (onCallLimit && typeof limit === 'string') {
      const [used, max] = limit.split('/').map(Number);
      if (Number.isFinite(used) && Number.isFinite(max)) {
        await onCallLimit(site, max - used).catch(() => {});
      }
    }
    return JSON.parse(res.body.toString('utf8') || 'null') as T;
  }

  // A real article has no URL field: it is the shop's domain, the blog's handle and its own.
  async function urlOf(
    site: Site,
    a: ShopifyArticle,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (a.url) {
      return a.url;
    }
    let root = publicBlog.get(site.id);
    if (!root) {
      root = Promise.all([
        call<{ shop: { domain: string } }>(site, `${shop(site)}/shop.json`, {}, signal),
        call<{ blog: { handle: string } }>(site, `${blog(site)}.json`, {}, signal),
      ]).then(([s, b]) => `https://${s.shop.domain}/blogs/${b.blog.handle}`);
      root.catch(() => publicBlog.delete(site.id));
      publicBlog.set(site.id, root);
    }
    return `${await root}/${a.handle}`;
  }

  const live = (a: ShopifyArticle) => a.published ?? Boolean(a.published_at);
  const remote = async (
    site: Site,
    a: ShopifyArticle,
    signal?: AbortSignal,
  ): Promise<RemotePost> => ({
    id: String(a.id),
    articleId:
      a.article_id ??
      a.metafields?.find((m) => m.namespace === 'ryze' && m.key === 'article_id')?.value ??
      null,
    status: live(a) ? 'live' : 'draft',
    url: live(a) ? await urlOf(site, a, signal) : undefined,
  });

  const adapter: PlatformAdapter = {
    async verify(site, signal) {
      await call(site, `${shop(site)}/shop.json`, {}, signal);
    },

    async findMedia() {
      return null;
    },

    async uploadMedia(_site, filename) {
      return filename; // The cover is uploaded inline by createDraft.
    },

    async findBySlug(site, slug, signal) {
      const { articles } = await call<{ articles: ShopifyArticle[] }>(
        site,
        `${blog(site)}/articles.json?handle=${encodeURIComponent(slug)}`,
        {},
        signal,
      );
      return articles[0] ? remote(site, articles[0], signal) : null;
    },

    async createDraft(site, a, signal) {
      signal?.throwIfAborted();
      const image = { attachment: (await a.image()).toString('base64'), filename: a.mediaId };
      signal?.throwIfAborted();
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
          signal,
        );
        return String(article.id);
      } catch (err) {
        // The handle is taken: an earlier attempt created this article. Adopt it.
        if (err instanceof HttpError && err.status === 422) {
          const found = await adapter.findBySlug(site, a.slug, signal);
          if (found) {
            if (found.articleId && found.articleId !== a.articleId) {
              throw new Permanent('slug belongs to another article');
            }
            return found.id;
          }
        }
        throw err;
      }
    },

    async getStatus(site, postId, signal) {
      const { article } = await call<{ article: ShopifyArticle }>(
        site,
        `${blog(site)}/articles/${postId}.json`,
        {},
        signal,
      );
      return remote(site, article, signal);
    },

    async publish(site, postId, signal) {
      const { article } = await call<{ article: ShopifyArticle }>(
        site,
        `${blog(site)}/articles/${postId}.json`,
        { method: 'PUT', json: { article: { published: true } } },
        signal,
      );
      return (await urlOf(site, { ...article, published: true }, signal)) ?? '';
    },

    async deleteDraft(site, postId, signal) {
      await call(site, `${blog(site)}/articles/${postId}.json`, { method: 'DELETE' }, signal);
    },
  };
  return adapter;
}
