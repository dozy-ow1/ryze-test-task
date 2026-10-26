import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// Integration tests talk to the Compose postgres from the host. Each test file works in its own
// throwaway schema, so they never touch the demo's tables.
const env = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
process.env.TEST_DATABASE_URL ??= `postgres://ryze:ryze@localhost:${env.POSTGRES_PORT || 5432}/ryze`;

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@ryze\/shared$/,
        replacement: fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      },
      {
        find: /^@ryze\/shared\/(.+)$/,
        replacement: `${fileURLToPath(new URL('./packages/shared/src/', import.meta.url))}$1`,
      },
    ],
  },
  test: {
    include: ['apps/*/src/**/*.spec.ts', 'packages/*/src/**/*.spec.ts', 'tools/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
