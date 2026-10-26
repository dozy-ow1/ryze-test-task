import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttp, getJson, ResponseTooLarge } from './http.js';
import { validateHttpUrl } from './network-policy.js';

const server = createServer((req, res) => {
  if (req.url === '/large') {
    res.write(Buffer.alloc(800));
    res.end(Buffer.alloc(800));

    return;
  }

  if (req.url === '/invalid') {
    res.end('private invalid JSON content');

    return;
  }

  if (req.url === '/error') {
    res.writeHead(500);
    res.end('private upstream content');

    return;
  }

  res.end('ok');
});

let port: number;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('outbound network boundary', () => {
  it('rejects private IP literals and DNS answers by default', async () => {
    const http = createHttp(1000);
    await expect(http(`http://127.0.0.1:${port}`)).rejects.toThrow('private network');
    await expect(http(`http://localhost:${port}`)).rejects.toThrow('private network');
  });

  it('permits explicitly trusted local test transports', async () => {
    const http = createHttp(1000, { allowPrivateNetwork: true });
    expect((await http(`http://127.0.0.1:${port}`)).body.toString()).toBe('ok');
  });

  it('does not send requests with an aborted lease signal', async () => {
    const controller = new AbortController();
    const reason = new Error('lease lost');
    controller.abort(reason);
    await expect(
      createHttp(1000, { allowPrivateNetwork: true })(`http://127.0.0.1:${port}`, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it('bounds chunked response bytes and keeps upstream error bodies out of messages', async () => {
    const http = createHttp(1000, { allowPrivateNetwork: true, maxResponseBytes: 1024 });
    await expect(http(`http://127.0.0.1:${port}/large`)).rejects.toBeInstanceOf(ResponseTooLarge);
    const error = await http(`http://127.0.0.1:${port}/error`).catch((err) => err);
    expect(error.status).toBe(500);
    expect(error.message).not.toContain('private upstream content');
  });

  it('does not leak malformed JSON into an error message', async () => {
    await expect(
      getJson(createHttp(1000, { allowPrivateNetwork: true }), `http://127.0.0.1:${port}/invalid`),
    ).rejects.toMatchObject({ status: 502, message: 'upstream returned invalid JSON' });
  });

  it('rejects credential-bearing and non-HTTP URLs', () => {
    expect(() => validateHttpUrl('http://user:password@example.com')).toThrow();
    expect(() => validateHttpUrl('file:///etc/passwd')).toThrow();
  });
});
