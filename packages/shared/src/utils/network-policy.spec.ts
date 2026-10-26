import { describe, expect, it } from 'vitest';
import { createNetworkPolicy, isPublicAddress } from './network-policy.js';

describe('public network policy', () => {
  it('blocks loopback, private, link-local and IPv4-mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }

    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('requires explicit trust for local service URLs', () => {
    const url = new URL('http://127.0.0.1:8080');
    expect(() => createNetworkPolicy({}).checkUrl(url)).toThrow('private network');
    expect(() => createNetworkPolicy({ allowedHosts: ['127.0.0.1'] }).checkUrl(url)).not.toThrow();
  });
});
