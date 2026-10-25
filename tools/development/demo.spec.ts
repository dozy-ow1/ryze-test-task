import { describe, expect, it } from 'vitest';
import { runDemo } from './demo.js';

// The demo against the full Compose stack, smaller and without kills. Opt in: E2E=1 pnpm test.
describe.skipIf(!process.env.E2E)('end to end', () => {
  it(
    'publishes 50 articles exactly once through faulty providers and platforms',
    async () => {
      expect(await runDemo({ articles: 50, kills: false, deadlineMinutes: 10 })).toBe(true);
    },
    12 * 60_000,
  );
});
