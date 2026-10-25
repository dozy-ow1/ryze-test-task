import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
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

// One undici agent per process (keep-alive) and a deadline on every request, body included.
export interface HttpOptions {
  allowPrivateNetwork?: boolean;
  allowedHosts?: readonly string[];
}

// Check the address actually used by the socket, rather than a separate preflight DNS lookup.
// This prevents DNS rebinding between validation and connection establishment.
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blocked.check(address, 'ipv4');
  }
  return family === 6 && /^[23]/i.test(address) && !blocked.check(address, 'ipv6');
}

export function validateHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL must use HTTP(S) without credentials');
  }
  return url;
}

export function createHttp(timeoutMs: number, options: HttpOptions = {}): Http {
  const allowed = (hostname: string) =>
    options.allowPrivateNetwork || options.allowedHosts?.includes(hostname);
  const dispatcher = new Agent({
    keepAliveTimeout: 10_000,
    connections: 128,
    connect: {
      lookup(hostname, opts, callback) {
        lookup(hostname, { ...opts, all: true }, (err, addresses) => {
          if (err) {
            return callback(err, [], undefined);
          }
          if (!allowed(hostname) && addresses.some(({ address }) => !isPublicAddress(address))) {
            return callback(new Error('private network address is not allowed'), [], undefined);
          }
          if (opts.all) {
            callback(null, addresses);
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        });
      },
    },
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
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const where = `${method} ${parsed.pathname}`; // no query string, no credentials
    try {
      req.signal?.throwIfAborted();
      if (isIP(hostname) && !allowed(hostname) && !isPublicAddress(hostname)) {
        throw new Error('private network address is not allowed');
      }
      const res = await request(url, {
        method,
        headers,
        body,
        dispatcher,
        signal: req.signal
          ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
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
      req.signal?.throwIfAborted();
      if (err instanceof HttpError) {
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
  return JSON.parse(res.body.toString('utf8') || 'null') as T;
}

function retryAfterSeconds(value: string | string[] | undefined): number | undefined {
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
