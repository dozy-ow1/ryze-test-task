// Change operational limits here; deployments only configure credentials and destinations.
export const POOL_LIMITS = {
  generate: { concurrency: 8, leaseSeconds: 120 },
  publish: { concurrency: 16, leaseSeconds: 60 },
} as const;

export const IMAGE_CONCURRENCY = 4;
export const MAX_ATTEMPTS = 8;
export const HTTP_TIMEOUT_MS = 30_000;
export const GENERATION_TIMEOUT_MS = 120_000;
