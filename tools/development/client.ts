// Shared by development commands: the stack's ports on localhost.

export const API = 'http://localhost:8080';
export const PLATFORMS = 'http://localhost:8092';

export async function call<T = Record<string, unknown>>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();

  if (res.status >= 400) {
    throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
