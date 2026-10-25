import { randomBytes } from 'node:crypto';
import { FAULT_KINDS } from '@ryze/core';
import { API, call, PLATFORMS } from './client.js';

const PLATFORMS_IN_COMPOSE = 'http://mock-wordpress:8092';
export const ALL_FAULTS = [...FAULT_KINDS];

export interface DemoSite {
  id: string;
  token: string;
  platform: 'wordpress';
}

// Registers the token on the mock platform (with its faults), then the site through the API.
export async function registerMockSite(
  faults: { rate: number; kinds: string[] },
  endpoints = { api: API, platforms: PLATFORMS },
): Promise<DemoSite> {
  const platform = 'wordpress';
  const token = `wordpress-${randomBytes(12).toString('hex')}`;
  await call('POST', `${endpoints.platforms}/_admin/sites`, { token, platform, faults });
  const base_url = `${PLATFORMS_IN_COMPOSE}/wordpress`;

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
