import { describe, expect, it } from 'vitest';
import { reconcileConfig } from './config.js';

it('starts live reconciliation without generation keys or storage settings', () => {
  expect(
    reconcileConfig.parse({
      DATABASE_URL: 'postgres://user:password@localhost/db',
      SITE_TOKEN_KEY: Buffer.alloc(32).toString('base64'),
    }),
  ).toMatchObject({ SHOPIFY_MODE: 'live' });
});

describe('mock reconciliation', () => {
  it('requires an explicit mock endpoint', () => {
    expect(
      reconcileConfig.safeParse({
        DATABASE_URL: 'postgres://localhost/db',
        SITE_TOKEN_KEY: Buffer.alloc(32).toString('base64'),
        SHOPIFY_MODE: 'mock',
      }).success,
    ).toBe(false);
  });
});
