import { SHOPIFY_SCOPES } from '@ryze/shared';
import type { Post, Site } from './state.js';

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

// Protocol simulation for our adapter's operations, not a replacement for Shopify schema validation.
export function executeOperation(
  site: Site,
  query: string,
  v: Record<string, unknown>,
  origin: string,
) {
  const operation = query?.match(/(?:query|mutation)\s+(\w+)/)?.[1];
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
      return null;
  }
}
