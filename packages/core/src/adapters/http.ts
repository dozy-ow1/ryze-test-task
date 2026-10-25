import { Agent, request } from 'undici';

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

// One undici agent per process (keep-alive) and a deadline on every request, body included.
export function createHttp(timeoutMs: number): Http {
  const dispatcher = new Agent({ keepAliveTimeout: 10_000, connections: 128 });
  return async (url, req = {}) => {
    const method = req.method ?? 'GET';
    const headers = { ...req.headers };
    let body = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = 'application/json';
    }
    const where = `${method} ${new URL(url).pathname}`; // no query string, no credentials
    try {
      const res = await request(url, {
        method,
        headers,
        body,
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = Buffer.from(await res.body.arrayBuffer());
      if (res.statusCode >= 400) {
        const detail = buf.toString('utf8', 0, 200);
        throw new HttpError(
          res.statusCode,
          `${where}: HTTP ${res.statusCode} ${detail}`,
          retryAfterSeconds(res.headers['retry-after']),
        );
      }
      return { status: res.statusCode, headers: res.headers, body: buf };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const e = err as Error;
      const reason = e.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : e.message;
      throw new HttpError(0, `${where}: ${reason}`);
    }
  };
}

export async function getJson<T>(http: Http, url: string, req?: HttpRequest): Promise<T> {
  const res = await http(url, req);
  return JSON.parse(res.body.toString('utf8') || 'null') as T;
}

function retryAfterSeconds(value: string | string[] | undefined): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  const seconds = Number(v);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}
