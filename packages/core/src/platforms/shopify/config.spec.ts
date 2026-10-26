import { normalizeShopifyShop } from '@ryze/core';
import { describe, expect, it } from 'vitest';

describe('Shopify setup address', () => {
  it.each([
    'test-store.myshopify.com',
    'https://test-store.myshopify.com',
    ' https://test-store.myshopify.com/ ',
  ])('accepts hostname or HTTPS root: %s', (value) => {
    expect(normalizeShopifyShop(value)).toBe('test-store.myshopify.com');
  });

  it.each([
    '',
    'http://test-store.myshopify.com',
    'https://admin.shopify.com/store/test-store',
    'https://example.com',
    'https://test-store.myshopify.com/admin',
    'https://test-store.myshopify.com.attacker.example',
  ])('rejects unsupported addresses: %s', (value) => {
    expect(normalizeShopifyShop(value)).toBeNull();
  });
});
