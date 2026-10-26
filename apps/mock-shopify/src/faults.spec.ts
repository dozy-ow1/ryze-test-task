import { createHttp, createShopify, type FaultKind, HttpError, type Site } from '@ryze/core';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApps, inspect, listen, makeApp, mockCredentials, registerSite } from '../testing/helpers.js';

afterEach(closeApps);

describe('Shopify write faults', () => {
  it.each(['429', '500', 'timeout', 'slow', 'complete_then_drop'] as FaultKind[])(
    'injects %s without breaking recovery lookups',
    async (kind) => {
      const app = makeApp({ delays: { slowMs: [10, 10], timeoutHoldMs: 300 } });

      const base = await listen(app);

      const token = mockCredentials('fault-test');
      await registerSite(app, token, { rate: 1, kinds: [kind] });
      const http = createHttp(150, { allowPrivateNetwork: true });

      const adapter = createShopify((url, request) =>
        http(url.replace('https://test.myshopify.com', base), request),
      );

      const site: Site = {
        id: 'test',
        platform: 'shopify',
        base_url: 'https://test.myshopify.com',
        token,
      };

      const result = adapter.uploadMedia(site, 'cover.jpg', Buffer.from('jpeg'));

      if (kind === 'slow') {
        await expect(result).resolves.toMatch(/^gid:\/\/shopify\/MediaImage\//);
      } else {
        await expect(result).rejects.toBeInstanceOf(HttpError);
      }

      const found = await adapter.findMedia(site, 'cover.jpg');
      expect(found !== null).toBe(kind === 'slow' || kind === 'complete_then_drop');
      expect((await inspect(app)).sites[0].faults_injected[kind]).toBe(1);
    },
  );
});
