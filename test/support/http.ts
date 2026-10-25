import { type Http, HttpError, type HttpRequest } from '@ryze/core';

// Answers by "METHOD path" and records every request.
export function recordingHttp(routes: Record<string, (req: HttpRequest) => unknown>) {
  const calls: { key: string; req: HttpRequest }[] = [];
  const http: Http = async (url, req = {}) => {
    const u = new URL(url);
    const key = `${req.method ?? 'GET'} ${u.pathname}${u.search}`;
    calls.push({ key, req });
    const route = routes[key];
    if (!route) {
      throw new HttpError(404, `${key}: no route`);
    }
    const out = route(req) as { headers?: Record<string, string>; body: unknown };
    return {
      status: 200,
      headers: out.headers ?? {},
      body: Buffer.from(JSON.stringify(out.body)),
    };
  };
  return { http, calls };
}
