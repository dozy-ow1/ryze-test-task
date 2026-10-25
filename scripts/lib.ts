// Shared by the host-side scripts (seed, demo, smoke): the stack's ports on localhost.
import { randomBytes } from 'node:crypto';

export const API = 'http://localhost:8080';
export const PROVIDERS = 'http://localhost:8091';
export const PLATFORMS = 'http://localhost:8092';
// How the workers reach the fake platforms from inside Compose.
const PLATFORMS_IN_COMPOSE = 'http://fake-platforms:8092';

export const ALL_FAULTS = ['429', '500', 'timeout', 'slow', 'complete_then_drop'];

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

export interface DemoSite {
  id: string;
  token: string;
  platform: 'wordpress' | 'shopify';
}

// Registers the token on the fake platform (with its faults), then the site through the API.
export async function registerFakeSite(
  platform: 'wordpress' | 'shopify',
  faults: { rate: number; kinds: string[] },
  endpoints = { api: API, platforms: PLATFORMS },
): Promise<DemoSite> {
  const token = `${platform}-${randomBytes(12).toString('hex')}`;
  await call('POST', `${endpoints.platforms}/_admin/sites`, { token, platform, faults });
  const base_url =
    platform === 'wordpress'
      ? `${PLATFORMS_IN_COMPOSE}/wordpress`
      : `${PLATFORMS_IN_COMPOSE}/shopify/admin/api/2026-10/blogs/1`;
  const site = await call<{ id: string }>('POST', `${endpoints.api}/sites`, {
    platform,
    base_url,
    token,
  });
  return { id: site.body.id, token, platform };
}

const TOPICS = [
  'How to keep basil alive on a windowsill',
  'Cold brew coffee at home without special gear',
  'Choosing running shoes for flat feet',
  'A beginner guide to sourdough starters',
  'Composting in a small apartment',
  'What to pack for a three-day hike',
  'Caring for a cast iron skillet',
  'Houseplants that survive low light',
  'Budget meal prep for a busy week',
  'How to clean white sneakers',
  'Picking a first mechanical keyboard',
  'Indoor herb gardens for winter',
];

export function brief(n: number): string {
  return `${TOPICS[n % TOPICS.length]} (article ${n})`;
}
