import { randomBytes } from 'node:crypto';
import { FAULT_KINDS } from '@ryze/shared';
import { API, call, SHOPIFY } from './client.js';

export const ALL_FAULTS = [...FAULT_KINDS];

export interface DemoSite {
  id: string;
  token: string;
  platform: 'shopify';
}

// Registers the token on the mock platform (with its faults), then the site through the API.
export async function registerMockSite(
  faults: { rate: number; kinds: string[] },
  endpoints = { api: API, shopify: SHOPIFY },
): Promise<DemoSite> {
  const platform = 'shopify';
  const clientId = `demo-${randomBytes(12).toString('hex')}`;

  const token = JSON.stringify({
    clientId,
    clientSecret: 'mock-secret',
    blogId: 'gid://shopify/Blog/1',
  });
  await call('POST', `${endpoints.shopify}/_admin/sites`, { token, platform, faults });
  const base_url = `https://${clientId}.myshopify.com`;

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
