import { createShopify, Deferred, type Http, HttpError, type HttpRequest, Permanent, type Site } from '@ryze/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const BLOG_ID = 'gid://shopify/Blog/12';
const POST_ID = 'gid://shopify/Article/34';
const FILE_ID = 'gid://shopify/MediaImage/56';

const site: Site = {
  id: 'shop-1',
  platform: 'shopify',
  base_url: 'https://test-store.myshopify.com',
  token: JSON.stringify({ clientId: 'client', clientSecret: 'secret', blogId: BLOG_ID }),
};

const article = {
  id: POST_ID,
  handle: 'ryze-article',
  isPublished: false,
  blog: { id: BLOG_ID, handle: 'news' },
  metafield: { value: 'article-1' },
};

const readyFile = () => ({
  id: FILE_ID,
  createdAt: new Date().toISOString(),
  fileStatus: 'READY',
  image: { url: 'https://cdn.shopify.com/cover.jpg' },
  alt: 'ryze-article-1.jpg',
});

function transport(answers: Record<string, unknown | ((req: HttpRequest) => unknown)>) {
  const calls: { url: string; req: HttpRequest; operation: string }[] = [];

  const http: Http = async (url, req = {}) => {
    const query = (req.json as { query?: string })?.query ?? '';

    const operation = url.endsWith('/access_token')
      ? 'token'
      : url.includes('upload.example.com')
        ? 'upload'
        : (query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? 'unknown');
    calls.push({ url, req, operation });
    const answer = answers[operation];

    if (answer === undefined) {
      throw new Error(`Unexpected Shopify operation: ${operation}`);
    }

    const value = typeof answer === 'function' ? answer(req) : answer;

    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
  };

  return { http, calls };
}

const token = { access_token: 'access-token', expires_in: 86399 };

const verification = {
  data: {
    currentAppInstallation: {
      accessScopes: ['write_content', 'read_files', 'write_files'].map((handle) => ({ handle })),
    },
    blog: { id: BLOG_ID },
  },
};

afterEach(() => vi.useRealTimers());

describe('Shopify publishing', () => {
  it('selects Shopify, verifies granted scopes, caches and renews expiring tokens', async () => {
    vi.useFakeTimers();
    const { http, calls } = transport({ token, VerifyPublisher: verification });
    const adapter = createShopify(http);
    await adapter.verify(site);
    await adapter.verify(site);
    expect(calls.filter((call) => call.operation === 'token')).toHaveLength(1);
    expect(calls[1].req.headers?.['X-Shopify-Access-Token']).toBe('access-token');
    expect(calls[0].req.body).toContain('grant_type=client_credentials');
    vi.advanceTimersByTime(86_400_000);
    await adapter.verify(site);
    expect(calls.filter((call) => call.operation === 'token')).toHaveLength(2);
  });

  it('invalidates cached credentials on rotation', async () => {
    const { http, calls } = transport({ token, VerifyPublisher: verification });
    const adapter = createShopify(http);
    await adapter.verify(site);
    await adapter.verify({
      ...site,
      token: JSON.stringify({ clientId: 'client', clientSecret: 'rotated', blogId: BLOG_ID }),
    });
    expect(calls.filter((call) => call.operation === 'token')).toHaveLength(2);
    expect(calls.at(-2)?.req.body).toContain('client_secret=rotated');
  });

  it('fails before generation when file scopes or the selected blog are missing', async () => {
    const missing = transport({
      token,
      VerifyPublisher: {
        data: {
          ...verification.data,
          currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
        },
      },
    });
    await expect(createShopify(missing.http).verify(site)).rejects.toThrow(
      'read_files, write_files',
    );
    const noBlog = transport({
      token,
      VerifyPublisher: { data: { ...verification.data, blog: null } },
    });
    await expect(createShopify(noBlog.http).verify(site)).rejects.toThrow('blog does not exist');
  });

  it('rejects arbitrary hosts and malformed credentials before sending secrets', async () => {
    const { http, calls } = transport({ token });
    const adapter = createShopify(http);
    await expect(
      adapter.findBySlug({ ...site, base_url: 'https://attacker.example' }, 'slug'),
    ).rejects.toThrow('myshopify.com');
    await expect(adapter.verify({ ...site, token: 'not-json' })).rejects.toBeInstanceOf(Permanent);
    expect(calls).toHaveLength(0);
  });

  it('looks up exact handles within the selected blog and returns ownership', async () => {
    const { http, calls } = transport({
      token,
      FindArticle: {
        data: {
          articles: { nodes: [{ ...article, blog: { id: 'other', handle: 'other' } }, article] },
          shop: { primaryDomain: { url: 'https://store.example' } },
        },
      },
    });

    const result = await createShopify(http).findBySlug(site, 'ryze-article');
    expect(result).toMatchObject({
      id: POST_ID,
      articleId: 'article-1',
      status: 'draft',
      url: 'https://store.example/blogs/news/ryze-article',
    });
    expect((calls[1].req.json as { variables: { query: string } }).variables.query).toContain(
      'blog_id:12',
    );
  });

  it('uploads multipart bytes without forwarding the API token and persists a deterministic filename', async () => {
    const { http, calls } = transport({
      token,
      StageCover: {
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.example.com/target',
                resourceUrl: 'https://upload.example.com/resource',
                parameters: [{ name: 'key', value: 'signed-key' }],
              },
            ],
            userErrors: [],
          },
        },
      },
      upload: {},
      SaveCover: { data: { fileCreate: { files: [readyFile()], userErrors: [] } } },
    });
    expect(
      await createShopify(http).uploadMedia(site, 'ryze-article-1.jpg', Buffer.from('jpeg-bytes')),
    ).toBe(FILE_ID);
    const uploaded = calls.find((call) => call.operation === 'upload');
    expect(uploaded?.req.headers?.['X-Shopify-Access-Token']).toBeUndefined();
    expect(uploaded?.req.body?.toString()).toContain('jpeg-bytes');
    expect(uploaded?.req.body?.toString()).toContain('signed-key');
    expect(
      (calls[calls.length - 1].req.json as { variables: { files: unknown[] } }).variables.files[0],
    ).toMatchObject({ filename: 'ryze-article-1.jpg', duplicateResolutionMode: 'RAISE_ERROR' });
  });

  it('retries a lost file creation response without accepting renamed duplicates', async () => {
    const answers = {
      token,
      FindCover: { data: { files: { nodes: [] as ReturnType<typeof readyFile>[] } } },
      StageCover: {
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.example.com/target',
                resourceUrl: 'https://upload.example.com/resource',
                parameters: [],
              },
            ],
            userErrors: [],
          },
        },
      },
      upload: {},
      SaveCover: {
        data: {
          fileCreate: {
            files: [],
            userErrors: [{ code: 'FILENAME_ALREADY_EXISTS', message: 'Already created' }],
          },
        },
      },
    };

    const { http, calls } = transport(answers);
    const adapter = createShopify(http);
    await expect(
      adapter.uploadMedia(site, 'ryze-article-1.jpg', Buffer.from('jpeg')),
    ).rejects.toMatchObject({ status: 503 });
    answers.FindCover.data.files.nodes.push(readyFile());
    expect(await adapter.findMedia(site, 'ryze-article-1.jpg')).toBe(FILE_ID);
    expect(calls.filter((call) => call.operation === 'SaveCover')).toHaveLength(1);
  });

  it('redacts upstream token errors', async () => {
    const { http } = transport({
      token: () => {
        throw new HttpError(401, 'secret echoed upstream');
      },
    });
    await expect(createShopify(http).verify(site)).rejects.toThrow('Shopify token request failed');
    await expect(createShopify(http).verify(site)).rejects.not.toThrow('secret echoed upstream');
  });

  it('adopts an existing image and refuses failed processing', async () => {
    const answers = { token, FindCover: { data: { files: { nodes: [readyFile()] } } } };
    const { http } = transport(answers);
    expect(await createShopify(http).findMedia(site, 'ryze-article-1.jpg')).toBe(FILE_ID);
    answers.FindCover.data.files.nodes[0].fileStatus = 'FAILED';
    await expect(createShopify(http).findMedia(site, 'ryze-article-1.jpg')).rejects.toThrow(
      'processing failed',
    );
  });

  it('defers an unfinished image without creating a draft, then fails overdue processing', async () => {
    const file = { ...readyFile(), fileStatus: 'PROCESSING', image: null };
    const { http, calls } = transport({ token, CoverStatus: { data: { node: file } } });
    const adapter = createShopify(http);

    const input = {
      title: 'Title',
      slug: 'ryze-article',
      bodyHtml: '<p>Article</p>',
      mediaId: FILE_ID,
      articleId: 'article-1',
    };
    await expect(adapter.createDraft(site, input)).rejects.toBeInstanceOf(Deferred);
    expect(calls.some((call) => call.operation === 'CreateDraft')).toBe(false);
    file.createdAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await expect(adapter.createDraft(site, input)).rejects.toThrow('exceeded ten minutes');
  });

  it('creates an unpublished article with its cover and ownership marker', async () => {
    const { http, calls } = transport({
      token,
      CoverStatus: { data: { node: readyFile() } },
      CreateDraft: { data: { articleCreate: { article: { id: POST_ID }, userErrors: [] } } },
    });
    expect(
      await createShopify(http).createDraft(site, {
        title: 'Title',
        slug: 'ryze-article',
        bodyHtml: '<p>Article</p>',
        mediaId: FILE_ID,
        articleId: 'article-1',
      }),
    ).toBe(POST_ID);
    expect(
      (calls[calls.length - 1].req.json as { variables: { article: unknown } }).variables.article,
    ).toMatchObject({
      blogId: BLOG_ID,
      isPublished: false,
      image: { url: 'https://cdn.shopify.com/cover.jpg' },
      metafields: [{ value: 'article-1' }],
    });
  });

  it('publishes a draft and skips already published articles', async () => {
    const answers = {
      token,
      ArticleStatus: {
        data: {
          article: { ...article },
          shop: { primaryDomain: { url: 'https://store.example' } },
        },
      },
      PublishArticle: {
        data: { articleUpdate: { article: { ...article, isPublished: true }, userErrors: [] } },
      },
    };

    const { http, calls } = transport(answers);
    const adapter = createShopify(http);
    expect(await adapter.publish(site, POST_ID)).toBe(
      'https://store.example/blogs/news/ryze-article',
    );
    answers.ArticleStatus.data.article.isPublished = true;
    await adapter.publish(site, POST_ID);
    expect(calls.filter((call) => call.operation === 'PublishArticle')).toHaveLength(1);
  });

  it('does not delete live articles or access an article from another blog', async () => {
    const answers = {
      token,
      ArticleStatus: {
        data: {
          article: { ...article, isPublished: true },
          shop: { primaryDomain: { url: 'https://store.example' } },
        },
      },
    };

    const { http } = transport(answers);
    const adapter = createShopify(http);
    await expect(adapter.deleteDraft(site, POST_ID)).rejects.toThrow('Refusing to delete');
    answers.ArticleStatus.data.article.blog = { id: 'another-blog', handle: 'other' };
    await expect(adapter.getStatus(site, POST_ID)).rejects.toThrow('another blog');
  });

  it('classifies GraphQL throttling, permissions and business errors without leaking messages', async () => {
    for (const [code, expected] of [
      ['THROTTLED', 429],
      ['INTERNAL_SERVER_ERROR', 503],
      ['ACCESS_DENIED', 403],
    ] as const) {
      const { http } = transport({
        token,
        VerifyPublisher: {
          errors: [{ message: 'sensitive upstream detail', extensions: { code } }],
        },
      });
      await expect(createShopify(http).verify(site)).rejects.toMatchObject({ status: expected });
    }

    const { http } = transport({
      token,
      CoverStatus: { data: { node: readyFile() } },
      CreateDraft: {
        data: {
          articleCreate: {
            article: null,
            userErrors: [{ code: 'INVALID', message: 'secret detail' }],
          },
        },
      },
    });
    await expect(
      createShopify(http).createDraft(site, {
        title: 'Title',
        slug: 'slug',
        bodyHtml: 'text',
        mediaId: FILE_ID,
        articleId: 'article-1',
      }),
    ).rejects.toThrow('INVALID');
  });

  it('invalidates a rejected token without replaying the request inside the adapter', async () => {
    let attempts = 0;

    const { http, calls } = transport({
      token,

      VerifyPublisher: () => {
        if (++attempts === 1) {
          throw new HttpError(401, 'expired');
        }

        return verification;
      },
    });

    const adapter = createShopify(http);
    await expect(adapter.verify(site)).rejects.toMatchObject({ status: 503 });
    await adapter.verify(site);
    expect(calls.filter((call) => call.operation === 'token')).toHaveLength(2);
  });
});
