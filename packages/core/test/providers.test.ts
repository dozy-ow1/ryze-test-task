import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  anthropicLlm,
  classify,
  type Http,
  HttpError,
  type HttpRequest,
  openaiImage,
  Permanent,
  shopify,
  wordpress,
} from '@ryze/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real providers and real-platform adapter paths, without real accounts: a local server stands
// in for the Messages API, and a recording Http stands in for OpenAI, Shopify and WordPress.

type Seen = { path?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
let reply: (seen: Seen) => { status: number; headers?: Record<string, string>; body: unknown };
let seen: Seen;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  seen = { path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} };
  const out = reply(seen);
  res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
  res.end(JSON.stringify(out.body));
});
let baseURL: string;

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const article = { title: 'Keep Basil Alive', body_html: '<p>Water it.</p>', image_prompt: 'basil' };
const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: JSON.stringify(article) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 120,
    output_tokens: 640,
    cache_read_input_tokens: 700,
    cache_creation_input_tokens: 0,
  },
  ...over,
});
const llm = () =>
  anthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', timeoutMs: 5_000, baseURL });

describe('anthropic LLM provider', () => {
  it('sends a cached system prefix, low effort and a JSON schema; maps the answer and usage', async () => {
    reply = () => ({ status: 200, body: message() });
    const out = await llm().generate({ brief: 'how to keep basil alive' });
    expect(out).toEqual({
      title: 'Keep Basil Alive',
      bodyHtml: '<p>Water it.</p>',
      imagePrompt: 'basil',
      model: 'claude-sonnet-5-5',
      usage: {
        input_tokens: 120,
        output_tokens: 640,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 0,
      },
    });
    expect(seen.path).toMatch(/^\/v1\/messages/);
    // SDK 1.x sends the key as a Bearer token; older ones used x-api-key.
    expect(`${seen.headers['x-api-key'] ?? seen.headers.authorization}`).toContain('sk-test');
    expect(String(seen.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    const body = seen.body as {
      model: string;
      max_tokens: number;
      fallbacks: string;
      system: { text: string; cache_control: unknown }[];
      messages: { content: string }[];
      output_config: { effort: string; format: { type: string; schema: { required: string[] } } };
    };
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
      fallbacks: 'default',
    });
    expect(body.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text.length).toBeGreaterThan(2_000); // past the 512-token cache minimum
    expect(body.messages[0].content).toContain('how to keep basil alive');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toEqual(
      expect.arrayContaining(['title', 'body_html', 'image_prompt']),
    );
  });

  it('turns API errors into the shared HttpError shape', async () => {
    reply = () => ({
      status: 429,
      headers: { 'retry-after': '7' },
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    });
    const limited = await llm()
      .generate({ brief: 'b' })
      .catch((e) => e);
    expect(limited).toBeInstanceOf(HttpError);
    expect(limited).toMatchObject({ status: 429, retryAfter: 7 });
    expect(classify(limited)).toBe('transient');

    reply = () => ({
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    });
    const overloaded = await llm()
      .generate({ brief: 'b' })
      .catch((e) => e);
    expect(overloaded).toMatchObject({ status: 529 });
    expect(classify(overloaded)).toBe('transient');

    reply = () => ({
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
    });
    expect(
      classify(
        await llm()
          .generate({ brief: 'b' })
          .catch((e) => e),
      ),
    ).toBe('permanent');

    const down = anthropicLlm({
      apiKey: 'k',
      model: 'm',
      timeoutMs: 2_000,
      baseURL: 'http://127.0.0.1:1',
    });
    expect(await down.generate({ brief: 'b' }).catch((e) => e)).toMatchObject({ status: 0 });
  });

  it('treats a refusal as permanent', async () => {
    reply = () => ({
      status: 200,
      body: message({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      }),
    });
    const err = await llm()
      .generate({ brief: 'b' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Permanent);
  });
});

// Answers by "METHOD path" and records every request.
function recordingHttp(routes: Record<string, (req: HttpRequest) => unknown>) {
  const calls: { key: string; req: HttpRequest }[] = [];
  const http: Http = async (url, req = {}) => {
    const u = new URL(url);
    const key = `${req.method ?? 'GET'} ${u.pathname}${u.search}`;
    calls.push({ key, req });
    const route = routes[key];
    if (!route) throw new HttpError(404, `${key}: no route`);
    const out = route(req) as { headers?: Record<string, string>; body: unknown };
    return {
      status: 200,
      headers: out.headers ?? {},
      body: Buffer.from(JSON.stringify(out.body)),
    };
  };
  return { http, calls };
}

describe('openai image provider', () => {
  it('is synchronous and returns the decoded image', async () => {
    const { http, calls } = recordingHttp({
      'POST /v1/images/generations': () => ({
        body: { data: [{ b64_json: Buffer.from('png bytes').toString('base64') }] },
      }),
    });
    const image = openaiImage(http, { apiKey: 'sk-o', model: 'gpt-image-1' });
    expect(image.kind).toBe('sync');
    expect((await image.generate?.('basil'))?.toString()).toBe('png bytes');
    expect(calls[0].req.headers?.authorization).toBe('Bearer sk-o');
    expect(calls[0].req.json).toMatchObject({ model: 'gpt-image-1', prompt: 'basil' });
  });
});

describe('shopify adapter against a real store', () => {
  const site = {
    id: 'site-1',
    platform: 'shopify' as const,
    base_url: 'https://test-store.myshopify.com/admin/api/2026-10/blogs/9',
    token: 'shpat_x',
  };
  const root = '/admin/api/2026-10';

  it('sends the cover inline, follows the call limit and builds the public URL', async () => {
    const limits: number[] = [];
    const { http, calls } = recordingHttp({
      [`GET ${root}/blogs/9/articles.json?handle=keep-basil-alive-1`]: () => ({
        body: { articles: [] },
      }),
      [`POST ${root}/blogs/9/articles.json`]: () => ({
        headers: { 'x-shopify-shop-api-call-limit': '32/40' },
        body: { article: { id: 55, handle: 'keep-basil-alive-1', published_at: null } },
      }),
      [`PUT ${root}/blogs/9/articles/55.json`]: () => ({
        body: { article: { id: 55, handle: 'keep-basil-alive-1', published_at: '2026-10-25' } },
      }),
      [`GET ${root}/shop.json`]: () => ({ body: { shop: { domain: 'shop.example.com' } } }),
      [`GET ${root}/blogs/9.json`]: () => ({ body: { blog: { handle: 'news' } } }),
    });
    const adapter = shopify(http, async (_site, available) => {
      limits.push(available);
    });

    expect(await adapter.findMedia(site, 'ryze-1.jpg')).toBeNull();
    expect(await adapter.uploadMedia(site, 'ryze-1.jpg', Buffer.from('cover'))).toBe('ryze-1.jpg');
    expect(calls).toHaveLength(0); // a real store has no media library to call

    expect(await adapter.findBySlug(site, 'keep-basil-alive-1')).toBeNull();
    const id = await adapter.createDraft(site, {
      title: 'Keep Basil Alive',
      slug: 'keep-basil-alive-1',
      bodyHtml: '<p>x</p>',
      mediaId: 'ryze-1.jpg',
      articleId: 'a-1',
      image: async () => Buffer.from('cover'),
    });
    expect(id).toBe('55');
    const created = calls.find((c) => c.key.startsWith('POST'))?.req;
    expect(created?.headers?.['x-shopify-access-token']).toBe('shpat_x');
    expect(created?.json).toMatchObject({
      article: {
        published: false,
        image: { attachment: Buffer.from('cover').toString('base64'), filename: 'ryze-1.jpg' },
        metafields: [{ namespace: 'ryze', key: 'article_id', value: 'a-1' }],
      },
    });
    expect(limits).toEqual([8]);
    expect(await adapter.publish(site, '55')).toBe(
      'https://shop.example.com/blogs/news/keep-basil-alive-1',
    );
  });
});

describe('wordpress adapter against a real site', () => {
  const site = {
    id: 'site-2',
    platform: 'wordpress' as const,
    base_url: 'https://blog.example.com/wp-json',
    token: 'editor:abcd efgh',
  };

  it('uses Application Passwords and drops an unregistered meta field', async () => {
    let attempts = 0;
    const { http, calls } = recordingHttp({
      'POST /wp-json/wp/v2/posts': (req) => {
        attempts++;
        if ((req.json as { meta?: unknown }).meta) {
          throw new HttpError(
            400,
            'POST /wp-json/wp/v2/posts: HTTP 400 {"code":"rest_invalid_param","message":"Invalid parameter(s): meta"}',
          );
        }
        return { body: { id: 77, status: 'draft', link: 'https://blog.example.com/?p=77' } };
      },
    });
    const id = await wordpress(http).createDraft(site, {
      title: 't',
      slug: 's',
      bodyHtml: '<p>x</p>',
      mediaId: '12',
      articleId: 'a-2',
      image: async () => Buffer.alloc(0),
    });
    expect(id).toBe('77');
    expect(attempts).toBe(2);
    expect(calls[0].req.headers?.authorization).toBe(
      `Basic ${Buffer.from('editor:abcd efgh').toString('base64')}`,
    );
  });
});
