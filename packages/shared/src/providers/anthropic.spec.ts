import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classify, createAnthropic, HttpError, Permanent } from '@ryze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Seen = { path?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
let reply: (seen: Seen) => { status: number; headers?: Record<string, string>; body: unknown };
let seen: Seen;

const server = createServer(async (req, res) => {
  let raw = '';

  for await (const chunk of req) {
    raw += chunk;
  }

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
  createAnthropic({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', timeoutMs: 5_000, baseURL });

describe('anthropic LLM provider', () => {
  it('sends a concise system prompt, low effort and a JSON schema; maps the answer and usage', async () => {
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
    const body = seen.body as {
      model: string;
      max_tokens: number;
      system: string;
      messages: { content: string }[];
      output_config: { effort: string; format: { type: string; schema: { required: string[] } } };
    };
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
    });
    expect(body.system).toContain('600–900 word body');
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

    const down = createAnthropic({
      apiKey: 'k',
      model: 'm',
      timeoutMs: 2_000,
      baseURL: 'http://127.0.0.1:1',
    });
    expect(await down.generate({ brief: 'b' }).catch((e) => e)).toMatchObject({ status: 0 });
  });

  it('rejects malformed article output without leaking its content or paying for retries', async () => {
    reply = () => ({
      status: 200,
      body: message({ content: [{ type: 'text', text: 'private invalid article JSON' }] }),
    });
    const error = await llm()
      .generate({ brief: 'b' })
      .catch((err) => err);
    expect(error).toBeInstanceOf(Permanent);
    expect(error.message).toBe('model returned invalid article JSON');
  });

  it('stops paid retries for token-truncated output before parsing JSON', async () => {
    reply = () => ({
      status: 200,
      body: message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"title":' }] }),
    });
    const error = await llm()
      .generate({ brief: 'b' })
      .catch((err) => err);
    expect(error).toBeInstanceOf(Permanent);
    expect(error.message).toContain('token limit');
  });

  it.each([
    { content: [] },
    { content: [{ type: 'text', text: 'I cannot help with that request.' }] },
  ])('treats a refusal as permanent before attempting JSON parsing: %j', async ({ content }) => {
    reply = () => ({
      status: 200,
      body: message({
        content,
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      }),
    });
    const err = await llm()
      .generate({ brief: 'b' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Permanent);
    expect(classify(err)).toBe('permanent');
  });
});
