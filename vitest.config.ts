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
    alias: {
      '@ryze/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
