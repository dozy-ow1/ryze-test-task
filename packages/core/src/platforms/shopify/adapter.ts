import { Permanent } from '../../utils/errors.js';
import type { Http } from '../../utils/http.js';
import type { PlatformAdapter, RemotePost, Site } from '../types.js';
import { checkUserErrors, createShopifyClient, credentials, type UserError } from './client.js';
import { SHOPIFY_SCOPES } from './config.js';
import { createShopifyMedia } from './media.js';

interface Article {
  id: string;
  handle: string;
  isPublished: boolean;
  blog: { id: string; handle: string };
  metafield: { value: string } | null;
}

const ARTICLE_FIELDS =
  'id handle isPublished blog { id handle } metafield(namespace: "ryze", key: "article_id") { value }';

function remote(article: Article, origin: string): RemotePost {
  return {
    id: article.id,
    status: article.isPublished ? 'live' : 'draft',
    url: `${origin.replace(/\/$/, '')}/blogs/${article.blog.handle}/${article.handle}`,
    articleId: article.metafield?.value ?? null,
  };
}

export function createShopify(http: Http): PlatformAdapter {
  const graphql = createShopifyClient(http);
  const media = createShopifyMedia(http, graphql);

  async function readArticle(site: Site, id: string, signal?: AbortSignal) {
    const data = await graphql<{
      article: Article | null;
      shop: { primaryDomain: { url: string } };
    }>(
      site,
      `query ArticleStatus($id: ID!) { article(id: $id) { ${ARTICLE_FIELDS} } shop { primaryDomain { url } } }`,
      { id },
      signal,
    );

    if (!data.article || data.article.blog.id !== credentials(site).blogId) {
      throw new Permanent('Shopify article is missing or belongs to another blog');
    }

    return remote(data.article, data.shop.primaryDomain.url);
  }

  return {
    async verify(site, signal) {
      const data = await graphql<{
        currentAppInstallation: { accessScopes: { handle: string }[] };
        blog: { id: string } | null;
      }>(
        site,
        `query VerifyPublisher($id: ID!) { currentAppInstallation { accessScopes { handle } } blog(id: $id) { id } }`,
        { id: credentials(site).blogId },
        signal,
      );

      const granted = new Set(
        data.currentAppInstallation.accessScopes.map((scope) => scope.handle),
      );

      const missing = SHOPIFY_SCOPES.filter((scope) => !granted.has(scope));

      if (missing.length) {
        throw new Permanent(`Shopify installation needs scopes: ${missing.join(', ')}`);
      }

      if (!data.blog) {
        throw new Permanent('Configured Shopify blog does not exist');
      }
    },

    findMedia: media.findMedia,
    uploadMedia: media.uploadMedia,

    async findBySlug(site, slug, signal) {
      const blogId = credentials(site).blogId;

      const data = await graphql<{
        articles: { nodes: Article[] };
        shop: { primaryDomain: { url: string } };
      }>(
        site,
        `query FindArticle($query: String!) { articles(first: 10, query: $query) { nodes { ${ARTICLE_FIELDS} } } shop { primaryDomain { url } } }`,
        { query: `blog_id:${blogId.split('/').at(-1)} AND handle:${JSON.stringify(slug)}` },
        signal,
      );

      const article = data.articles.nodes.find(
        (item) => item.handle === slug && item.blog.id === blogId,
      );

      return article ? remote(article, data.shop.primaryDomain.url) : null;
    },

    async createDraft(site, input, signal) {
      const imageUrl = await media.imageUrl(site, input.mediaId, signal);

      const data = await graphql<{
        articleCreate: { article: { id: string } | null; userErrors: UserError[] };
      }>(
        site,
        `mutation CreateDraft($article: ArticleCreateInput!) { articleCreate(article: $article) { article { id } userErrors { code field message } } }`,
        {
          article: {
            blogId: credentials(site).blogId,
            title: input.title,
            handle: input.slug,
            body: input.bodyHtml,
            author: { name: 'Ryze' },
            isPublished: false,
            image: { url: imageUrl, altText: input.title },
            metafields: [
              {
                namespace: 'ryze',
                key: 'article_id',
                type: 'single_line_text_field',
                value: input.articleId,
              },
            ],
          },
        },
        signal,
      );
      checkUserErrors(data.articleCreate.userErrors);

      if (!data.articleCreate.article) {
        throw new Permanent('Shopify returned no created article');
      }

      return data.articleCreate.article.id;
    },

    getStatus: readArticle,

    async publish(site, postId, signal) {
      const current = await readArticle(site, postId, signal);

      if (current.status === 'live' && current.url) {
        return current.url;
      }

      const data = await graphql<{
        articleUpdate: { article: Article | null; userErrors: UserError[] };
      }>(
        site,
        `mutation PublishArticle($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { ${ARTICLE_FIELDS} } userErrors { code field message } } }`,
        { id: postId, article: { isPublished: true } },
        signal,
      );
      checkUserErrors(data.articleUpdate.userErrors);

      if (!data.articleUpdate.article?.isPublished) {
        throw new Permanent('Shopify did not publish the article');
      }

      return current.url as string;
    },

    async deleteDraft(site, postId, signal) {
      const current = await readArticle(site, postId, signal);

      if (current.status === 'live') {
        throw new Permanent('Refusing to delete a published Shopify article');
      }

      const data = await graphql<{ articleDelete: { userErrors: UserError[] } }>(
        site,
        `mutation DeleteDraft($id: ID!) { articleDelete(id: $id) { userErrors { code field message } } }`,
        { id: postId },
        signal,
      );
      checkUserErrors(data.articleDelete.userErrors);
    },
  };
}
