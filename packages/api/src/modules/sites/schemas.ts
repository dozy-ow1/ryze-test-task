import { validateHttpUrl } from '@ryze/core';
import { z } from 'zod';

const siteUrl = z.url().refine((value) => {
  try {
    validateHttpUrl(value);

    return !value.includes('?') && !value.includes('#');
  } catch {
    return false;
  }
}, 'must be an HTTP(S) root without credentials, query or fragment');

export const tokenBody = z.object({ token: z.string().min(1) });

export const siteBody = tokenBody.extend({
  platform: z.literal('wordpress'),
  base_url: siteUrl,
});
