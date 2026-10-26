import { z } from 'zod';

export const SHOPIFY_API_VERSION = '2026-07';
export const SHOPIFY_SCOPES = ['write_content', 'read_files', 'write_files'] as const;

export const shopifyCredentials = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  blogId: z.string().regex(/^gid:\/\/shopify\/Blog\/\d+$/),
});

export function isShopifyUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

// Setup commands accept either the Shopify hostname or its full HTTPS URL.
export function normalizeShopifyShop(value: string): string | null {
  const host = value
    .trim()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '');

  return isShopifyUrl(`https://${host}`) ? host : null;
}
