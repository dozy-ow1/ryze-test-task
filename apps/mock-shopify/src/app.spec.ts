import { createHttp, createShopify, HttpError, type Site } from '@ryze/core';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApps, inspect, listen, makeApp, mockCredentials, registerSite } from '../testing/helpers.js';

afterEach(closeApps);

describe('Shopify mock', () => {
  it('requires valid client credentials and preserves uploaded image bytes', async () => {
    const app = makeApp();

    const base = await listen(app);

    const token = mockCredentials('test');
    await registerSite(app, token);
    const http = createHttp(5000, { allowPrivateNetwork: true });

    const adapter = createShopify((url, request) =>
      http(url.replace('https://test.myshopify.com', base), request),
    );

    const site: Site = {
      id: 'test',
      platform: 'shopify',
      base_url: 'https://test.myshopify.com',
      token,
    };
    await adapter.verify(site);
    await expect(
      adapter.verify({ ...site, id: 'other', token: mockCredentials('unknown') }),
    ).rejects.toBeInstanceOf(HttpError);
    const bytes = Buffer.from('jpeg-content');

    const id = await adapter.uploadMedia(site, 'cover.jpg', bytes);
    expect(await adapter.findMedia(site, 'cover.jpg')).toBe(id);
    expect(await (await fetch(`${base}/media/test/cover.jpg`)).text()).toBe(bytes.toString());
    const state = await inspect(app);
    expect(state.sites[0].media).toHaveLength(1);
  });

  it('rejects malformed registrations and invalid faults', async () => {
    const app = makeApp();

    for (const payload of [
      {},
      { platform: 'shopify', token: 'bad-json' },
      { platform: 'shopify', token: mockCredentials('test'), faults: { rate: 2 } },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/_admin/sites', payload })).statusCode).toBe(
        400,
      );
    }
  });
});
