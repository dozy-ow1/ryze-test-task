import { Agent, request } from 'undici';
import { createNetworkPolicy, type NetworkOptions, validateHttpUrl } from './network-policy.js';

// Every outbound failure becomes an HttpError so classify() sees one shape. status 0 means no HTTP
// answer at all: timeout, refused or dropped connection.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number, // seconds, from Retry-After
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequest {
  signal?: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: Buffer | string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type Http = (url: string, req?: HttpRequest) => Promise<HttpResponse>;

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface HttpOptions extends NetworkOptions {
  maxResponseBytes?: number;
}

export class ResponseTooLarge extends Error {
  constructor(limit: number) {
    super(`upstream response exceeded ${limit} bytes`);
    this.name = 'ResponseTooLarge';
  }
}

// Reuse connections; apply the deadline to both the response headers and body.
export function createHttp(timeoutMs: number, options: HttpOptions = {}): Http {
  const network = createNetworkPolicy(options);
  const limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('maxResponseBytes must be a positive integer');
  }

  const dispatcher = new Agent({
    keepAliveTimeout: 10_000,
    connections: 128,
    connect: { lookup: network.lookup },
  });

  return async (url, req = {}) => {
    const method = req.method ?? 'GET';
    const headers = { ...req.headers };
    let body = req.body;

    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = 'application/json';
    }

    const parsed = validateHttpUrl(url);
    const where = `${method} ${parsed.pathname}`; // no query string, no credentials

    try {
      req.signal?.throwIfAborted();
      network.checkUrl(parsed);

      const res = await request(url, {
        method,
        headers,
        body,
        dispatcher,
        signal: req.signal
          ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });

      const chunks: Buffer[] = [];
      let size = 0;

      for await (const chunk of res.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;

        if (size > limit) {
          throw new ResponseTooLarge(limit);
        }

        chunks.push(bytes);
      }

      const buf = Buffer.concat(chunks, size);

      if (res.statusCode >= 400) {
        throw new HttpError(
          res.statusCode,
          `${where}: HTTP ${res.statusCode}`,
          retryAfterSeconds(res.headers['retry-after']),
        );
      }

      return { status: res.statusCode, headers: res.headers, body: buf };
    } catch (err) {
      req.signal?.throwIfAborted();

      if (err instanceof HttpError || err instanceof ResponseTooLarge) {
        throw err;
      }

      const e = err as Error;
      const reason = e.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : e.message;

      throw new HttpError(0, `${where}: ${reason}`);
    }
  };
}

export async function getJson<T>(http: Http, url: string, req?: HttpRequest): Promise<T> {
  const res = await http(url, req);

  try {
    return JSON.parse(res.body.toString('utf8') || 'null') as T;
  } catch {
    throw new HttpError(502, 'upstream returned invalid JSON');
  }
}

export function retryAfterSeconds(value: string | string[] | undefined): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;

  if (!v) {
    return undefined;
  }

  const seconds = Number(v);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }

  const at = Date.parse(v);

  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}
