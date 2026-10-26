// Change operational limits here; deployments only configure credentials and destinations.
export const POOL_LIMITS = {
  generate: { concurrency: 8, leaseSeconds: 120 },
  publish: { concurrency: 16, leaseSeconds: 60 },
} as const;

export const IMAGE_CONCURRENCY = 4;
export const MAX_ATTEMPTS = 8;
export const HTTP_TIMEOUT_MS = 30_000;
export const GENERATION_TIMEOUT_MS = 120_000;

// Conservative request budgets per platform step; Shopify's own GraphQL throttling is authoritative.
export const SITE_REQUEST_UNITS = { verify: 1, upload: 3, draft: 3, publish: 2 } as const;
