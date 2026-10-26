import { isShopifyUrl, shopifyCredentials } from '@ryze/shared/platforms/shopify/config';
import { z } from 'zod';

const token = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      shopifyCredentials.parse(JSON.parse(value));

      return true;
    } catch {
      return false;
    }
  }, 'must be JSON containing clientId, clientSecret and blogId');

export const tokenBody = z.object({ token });

export const siteBody = tokenBody.extend({
  platform: z.literal('shopify'),
  base_url: z
    .url()
    .refine(
      isShopifyUrl,
      'must be an HTTPS *.myshopify.com store root without credentials, query or fragment',
    ),
});
